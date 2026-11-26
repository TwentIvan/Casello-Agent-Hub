// Protocollo del runner di collaudo: claim, ping, tunnel, file e report. Gli errori di regola sono CollaudoProtocolError
// con messaggio fisso; mai testo del runner nei messaggi né nei log (solo id).

import { createHash } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { db, releaseTestFilesTable, releaseTestsTable } from "@workspace/db";
import { COLLAUDO_MESSAGES } from "./messages";
import { expireOpenCommands } from "./commands";
import { LEASE_MS, CollaudoProtocolError, claimTest, type ClaimPackage } from "./tokens";

export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_SCREENSHOTS = 20;
export const MAX_TUNNEL_MS = 31 * 60_000;

export const PROTOCOL_MESSAGES = {
  tunnelUrl: "indirizzo del tunnel non valido",
  tunnelUntil: "scadenza del tunnel non valida",
  fileKind: "tipo di file non valido",
  fileName: "nome del file non valido",
  fileFormat: "formato del file non valido",
  fileTooLarge: "file troppo grande",
  tooManyFiles: "troppi file per questo collaudo",
  commandNotFound: "comando non trovato",
  delivered: "collaudo consegnato",
} as const;

let onTestClaimed: (testId: number, mode: "full" | "relight") => void = () => {};

/** Registra chi riceve l'avviso di un claim riuscito (il Task 6 avvia da qui l'agente collaudatore). */
export function setOnTestClaimed(fn: (testId: number, mode: "full" | "relight") => void): void {
  onTestClaimed = fn;
}

export async function claim(testId: number, code: string): Promise<ClaimPackage | null> {
  const pkg = await claimTest(testId, code);
  if (pkg) {
    try {
      onTestClaimed(testId, pkg.mode);
    } catch {
      // l'avvio dell'agente non deve far perdere il pacchetto al runner
    }
  }
  return pkg;
}

/** Il collaudo ha già l'esito o l'errore: l'agente ha finito e il runner passa al link dal vivo. */
export async function isDelivered(testId: number): Promise<boolean> {
  const [row] = await db
    .select({ outcome: releaseTestsTable.outcome, error: releaseTestsTable.error })
    .from(releaseTestsTable)
    .where(eq(releaseTestsTable.id, testId));
  return !row || row.outcome !== null || row.error !== null;
}

/** Rinnova la lease di 5 minuti. */
export async function ping(testId: number): Promise<Date> {
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  await db.update(releaseTestsTable).set({ leaseExpiresAt }).where(eq(releaseTestsTable.id, testId));
  return leaseExpiresAt;
}

const TUNNEL_URL = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.trycloudflare\.com\/?$/;

/** Indirizzo e scadenza del link dal vivo (`until` ≤ ora + 31 minuti). */
export async function setTunnel(testId: number, url: string, until: string): Promise<void> {
  if (typeof url !== "string" || url.length > 200 || !TUNNEL_URL.test(url)) {
    throw new CollaudoProtocolError(400, PROTOCOL_MESSAGES.tunnelUrl);
  }
  const untilMs = typeof until === "string" ? Date.parse(until) : Number.NaN;
  const now = Date.now();
  if (!Number.isFinite(untilMs) || untilMs <= now || untilMs > now + MAX_TUNNEL_MS) {
    throw new CollaudoProtocolError(400, PROTOCOL_MESSAGES.tunnelUntil);
  }
  await db
    .update(releaseTestsTable)
    .set({ tunnelUrl: url.replace(/\/$/, ""), tunnelUntil: new Date(untilMs) })
    .where(eq(releaseTestsTable.id, testId));
}

const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Nome del file: 1..200 caratteri visibili, senza `/`, `\` né `..`. */
function cleanFileName(raw: string | undefined): string {
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // resta com'è
  }
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > 200 || /[/\\\u0000-\u001f]/.test(name) || name.includes("..")) {
    throw new CollaudoProtocolError(400, PROTOCOL_MESSAGES.fileName);
  }
  return name;
}

/** Salva un video WebM o uno screenshot PNG: il tipo si legge dai primi byte, mai dall'intestazione. */
export async function saveFile(
  testId: number,
  input: { kind: string | undefined; name: string | undefined; bytes: Buffer },
): Promise<{ id: number }> {
  const { kind, bytes } = input;
  if (kind !== "video" && kind !== "screenshot") throw new CollaudoProtocolError(400, PROTOCOL_MESSAGES.fileKind);
  const name = cleanFileName(input.name);
  const magic = kind === "video" ? WEBM_MAGIC : PNG_MAGIC;
  if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic)) {
    throw new CollaudoProtocolError(400, PROTOCOL_MESSAGES.fileFormat);
  }
  if (bytes.length > (kind === "video" ? MAX_VIDEO_BYTES : MAX_SCREENSHOT_BYTES)) {
    throw new CollaudoProtocolError(413, PROTOCOL_MESSAGES.fileTooLarge);
  }
  const limit = kind === "video" ? 1 : MAX_SCREENSHOTS;
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(releaseTestFilesTable)
    .where(and(eq(releaseTestFilesTable.testId, testId), eq(releaseTestFilesTable.kind, kind)));
  if (n >= limit) throw new CollaudoProtocolError(413, PROTOCOL_MESSAGES.tooManyFiles);
  const [row] = await db
    .insert(releaseTestFilesTable)
    .values({
      testId,
      kind,
      name,
      contentType: kind === "video" ? "video/webm" : "image/png",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes,
    })
    .returning({ id: releaseTestFilesTable.id });
  return { id: row!.id };
}

/**
 * Report finale del runner: revoca il token e chiude il tunnel e i comandi aperti. Se il runner dichiara `failed` e
 * l'agente non ha consegnato nulla, il collaudo chiude `failed` con un messaggio fisso (mai il testo del runner).
 */
export async function report(testId: number, status: "done" | "failed"): Promise<void> {
  await db
    .update(releaseTestsTable)
    .set({ tokenHash: null, tokenExpiresAt: null, leaseExpiresAt: null, tunnelUrl: null, tunnelUntil: null })
    .where(eq(releaseTestsTable.id, testId));
  if (status === "failed") {
    await db
      .update(releaseTestsTable)
      .set({ status: "failed", error: COLLAUDO_MESSAGES.interrupted, finishedAt: new Date() })
      .where(
        and(
          eq(releaseTestsTable.id, testId),
          eq(releaseTestsTable.status, "running"),
          isNull(releaseTestsTable.outcome),
          isNull(releaseTestsTable.error),
        ),
      );
  }
  await expireOpenCommands(testId);
}
