// Protocollo del runner di collaudo: claim, ping, tunnel, file e report. Gli errori di regola sono CollaudoProtocolError
// con messaggio fisso; mai testo del runner nei messaggi né nei log (solo id).

import { createHash } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { db, releaseTestFilesTable, releaseTestsTable } from "@workspace/db";
import { logger } from "../logger";
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

type ClaimedHandler = (testId: number, mode: "full" | "relight") => void | Promise<void>;
let onTestClaimed: ClaimedHandler = () => {};

/** Registra chi riceve l'avviso di un claim riuscito (il Task 6 avvia da qui l'agente collaudatore). */
export function setOnTestClaimed(fn: ClaimedHandler): void {
  onTestClaimed = fn;
}

export async function claim(testId: number, code: string): Promise<ClaimPackage | null> {
  const pkg = await claimTest(testId, code);
  if (pkg) {
    // L'avvio dell'agente non deve far perdere il pacchetto al runner: errori sincroni e rifiuti asincroni si registrano
    const logFailure = (err: unknown) => logger.error({ testId, errName: err instanceof Error ? err.name : "unknown" }, "Avvio del collaudo dopo il claim non riuscito");
    try {
      void Promise.resolve(onTestClaimed(testId, pkg.mode)).catch(logFailure);
    } catch (err) {
      logFailure(err);
    }
  }
  return pkg;
}

/**
 * Il collaudo ha già l'esito o l'errore: l'agente ha finito. `liveLink` è vero solo con un esito da provare dal vivo (`ok` o
 * `problems`): altrimenti il runner riferisce subito, senza tunnel.
 */
export async function deliveryState(testId: number): Promise<{ delivered: boolean; liveLink: boolean }> {
  const [row] = await db
    .select({ outcome: releaseTestsTable.outcome, error: releaseTestsTable.error })
    .from(releaseTestsTable)
    .where(eq(releaseTestsTable.id, testId));
  if (!row) return { delivered: true, liveLink: false };
  const delivered = row.outcome !== null || row.error !== null;
  return { delivered, liveLink: row.outcome === "ok" || row.outcome === "problems" };
}

/** Rinnova la lease di 5 minuti. */
export async function ping(testId: number): Promise<Date> {
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  await db.update(releaseTestsTable).set({ leaseExpiresAt }).where(eq(releaseTestsTable.id, testId));
  return leaseExpiresAt;
}

// Mai `api.trycloudflare.com` (l'API di Cloudflare, non un quick tunnel)
const TUNNEL_URL = /^https:\/\/(?!api\.)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.trycloudflare\.com\/?$/;

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

type ReportedHandler = (testId: number) => void | Promise<void>;
let onTestReported: ReportedHandler = () => {};

/** Registra chi riceve l'avviso di un report del runner (lo scheduler ferma l'agente e lancia il collaudo successivo). */
export function setOnTestReported(fn: ReportedHandler): void {
  onTestReported = fn;
}

/**
 * Report finale del runner: in un solo UPDATE condizionato a `running` revoca token e lease, chiude il tunnel e decide lo stato
 * (una corsa con lo sweeper la vince uno solo). Esito dell'agente consegnato → `done` (si è perso al più il link dal vivo).
 * «Riaccendi» (nessun agente): `done` con `done`, `failed` «ricetta di avvio non riuscita» con `failed`. Altrimenti `failed`:
 * con l'errore già scritto dall'agente resta il suo, senza consegna «collaudo interrotto» (`failed`) o «collaudo non
 * consegnato» (`done`); mai il testo del runner. Poi si chiudono i comandi aperti.
 */
export async function report(testId: number, status: "done" | "failed"): Promise<void> {
  const t = releaseTestsTable;
  const relightOk = status === "done";
  const fallback = status === "failed" ? COLLAUDO_MESSAGES.interrupted : COLLAUDO_MESSAGES.notDelivered;
  await db
    .update(t)
    .set({
      status: sql`case when ${t.outcome} is not null then 'done' when ${t.mode} = 'relight' and ${relightOk}::boolean then 'done' else 'failed' end::release_test_status`,
      error: sql`case
        when ${t.outcome} is not null then ${t.error}
        when ${t.mode} = 'relight' then (case when ${relightOk}::boolean then null else ${COLLAUDO_MESSAGES.recipeFailed}::text end)
        when ${t.error} is not null then ${t.error}
        else ${fallback}::text end`,
      finishedAt: new Date(),
      tokenHash: null,
      tokenExpiresAt: null,
      leaseExpiresAt: null,
      tunnelUrl: null,
      tunnelUntil: null,
    })
    .where(and(eq(t.id, testId), eq(t.status, "running")));
  await expireOpenCommands(testId);
  try {
    await onTestReported(testId);
  } catch (err) {
    logger.error({ testId, errName: err instanceof Error ? err.name : "unknown" }, "Avviso del report del collaudo non riuscito");
  }
}
