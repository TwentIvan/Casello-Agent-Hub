// Abbinamento di un Mac dal browser (schema «device flow», spec §3): il nodo chiede un codice breve (`start`), l'utente
// lo approva in console con il login, il nodo ritira il token con `poll`, una volta sola. Nel DB solo gli hash del codice
// e del segreto del nodo; il token di nodo si crea solo al `poll` che consuma la richiesta.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db, nodePairingsTable, nodesTable, type NodePairing } from "@workspace/db";
import { createNodeToken } from "../api-tokens";
import { isUniqueViolation } from "../pg-errors";
import { NODE_MESSAGES, NodeNameConflictError, cleanNodeName, notifyStopped, revokeNodeTokens, NodeInputError } from "./nodes";

/** Alfabeto del codice: senza caratteri ambigui (0/O, 1/I/L, U). */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
/** Richieste più vecchie di così si cancellano, in qualunque stato. */
export const PAIRING_RETENTION_MS = 60 * 60_000;
export const MAX_FAILED_ATTEMPTS = 5;
/** Dopo l'approvazione la richiesta vive almeno altri 2 minuti: il tempo del nodo per ritirare il token. */
export const COLLECT_GRACE_MS = 2 * 60_000;

export const PAIRING_MESSAGES = {
  notFound: "richiesta di collegamento non trovata o scaduta",
  gone: "collegamento non più valido",
} as const;

/** Errore con lo stato HTTP da rispondere. */
export class PairingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Codice normalizzato: maiuscolo e solo caratteri dell'alfabeto (senza trattino); ammette il codice scritto a mano. */
export function normalizeUserCode(code: string): string {
  return [...code.toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join("");
}

function generateUserCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return raw;
}

const formatUserCode = (raw: string) => `${raw.slice(0, 4)}-${raw.slice(4)}`;

/** Indirizzo abbreviato: IPv4 all'/24, IPv6 all'/48 (non si conserva l'indirizzo preciso). */
export function abbreviateIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1]! : ip;
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v4);
  if (m4) return `${m4[1]}.${m4[2]}.${m4[3]}.0/24`;
  if (!ip.includes(":")) return null;
  const [head = "", tail = ""] = ip.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = ip.includes("::") && tail !== "" ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups] : headGroups;
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "").toLowerCase()).join(":")}::/48`;
}

/** Il codice di abbinamento sta nel percorso: nei log `/api/account/node-pairings/<codice>[/azione]` diventa `…/***[/azione]`. */
export function redactPairingPath(url: string): string {
  return url.replace(/^(\/api\/account\/node-pairings\/)[^/?#]+/i, "$1***");
}

export interface StartedPairing {
  pairingId: string;
  userCode: string;
  pollSecret: string;
  expiresAt: Date;
}

/** Crea la richiesta: codice per l'utente e segreto per il nodo, in chiaro solo in questa risposta. */
export async function startPairing(input: { deviceName: string; version: string; ip?: string }, now: Date = new Date()): Promise<StartedPairing> {
  const pollSecret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = generateUserCode();
    try {
      const [row] = await db
        .insert(nodePairingsTable)
        .values({
          userCodeHash: sha256(raw),
          pollSecretHash: sha256(pollSecret),
          deviceName: input.deviceName,
          version: input.version,
          requestIp: abbreviateIp(input.ip),
          expiresAt,
          createdAt: now,
        })
        .returning({ id: nodePairingsTable.id });
      return { pairingId: row!.id, userCode: formatUserCode(raw), pollSecret, expiresAt };
    } catch (err) {
      if (!isUniqueViolation(err, "node_pairings_user_code_hash_unique")) throw err;
    }
  }
  throw new Error("codice di abbinamento non generato");
}

export type PollResult = { status: "pending" } | { status: "approved"; token: string; nodeId: number; nodeName: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

const gone = () => new PairingError(410, PAIRING_MESSAGES.gone);

/**
 * Il nodo chiede l'esito. `pending` finché l'utente non decide; dopo l'approvazione consuma la richiesta (UPDATE
 * condizionato `approved` → `consumed`: un solo chiamante vince) e crea il token di nodo nella stessa transazione.
 * Rifiutata, scaduta, già consegnata o segreto sbagliato: `PairingError(410)`.
 */
export async function pollPairing(pairingId: string, pollSecret: string, now: Date = new Date()): Promise<PollResult> {
  if (!UUID_RE.test(pairingId)) throw gone();
  const [row] = await db.select().from(nodePairingsTable).where(eq(nodePairingsTable.id, pairingId));
  if (!row || !sameHash(row.pollSecretHash, sha256(pollSecret))) throw gone();
  if (row.expiresAt.getTime() <= now.getTime()) throw gone();
  if (row.status === "pending") return { status: "pending" };
  if (row.status !== "approved") throw gone();

  const out = await db.transaction(async (tx) => {
    const [won] = await tx
      .update(nodePairingsTable)
      .set({ status: "consumed" })
      .where(and(eq(nodePairingsTable.id, pairingId), eq(nodePairingsTable.status, "approved"), gt(nodePairingsTable.expiresAt, now)))
      .returning();
    if (!won || won.userId === null || won.nodeId === null) return null;
    const [node] = await tx
      .update(nodesTable)
      .set({ pairedAt: now, pairedIp: won.requestIp })
      .where(and(eq(nodesTable.id, won.nodeId), eq(nodesTable.userId, won.userId), eq(nodesTable.status, "active")))
      .returning();
    if (!node) throw gone();
    const token = await createNodeToken(tx, won.userId, node.id, `Nodo ${node.name}`);
    return { status: "approved" as const, token, nodeId: node.id, nodeName: node.name };
  });
  if (!out) throw gone();
  return out;
}

/** Richiesta `pending` e non scaduta per il codice dato; altrimenti `PairingError(404)`. */
async function findOpen(userCode: string, now: Date): Promise<NodePairing> {
  const raw = normalizeUserCode(userCode);
  if (raw.length !== CODE_LENGTH) throw new PairingError(404, PAIRING_MESSAGES.notFound);
  const [row] = await db
    .select()
    .from(nodePairingsTable)
    .where(and(eq(nodePairingsTable.userCodeHash, sha256(raw)), eq(nodePairingsTable.status, "pending"), gt(nodePairingsTable.expiresAt, now)));
  if (!row) throw new PairingError(404, PAIRING_MESSAGES.notFound);
  return row;
}

export interface PairingInfo {
  deviceName: string;
  version: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Dati della richiesta per la pagina di conferma (a qualunque utente con il login: il codice è il segreto). */
export async function getPairing(_userId: number, userCode: string, now: Date = new Date()): Promise<PairingInfo> {
  const row = await findOpen(userCode, now);
  return { deviceName: row.deviceName, version: row.version, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

/** Conta un approvazione fallita: alla quinta la richiesta scade. */
async function recordFailure(userCodeHash: string): Promise<void> {
  await db
    .update(nodePairingsTable)
    .set({
      failedAttempts: sql`${nodePairingsTable.failedAttempts} + 1`,
      status: sql`CASE WHEN ${nodePairingsTable.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} THEN 'expired'::node_pairing_status ELSE ${nodePairingsTable.status} END`,
    })
    .where(and(eq(nodePairingsTable.userCodeHash, userCodeHash), eq(nodePairingsTable.status, "pending")));
}

/**
 * Approva: nodo nuovo (`name`, regole di `createNode`) oppure `replaceNodeId`, un nodo attivo dell'utente che resta con
 * il suo nome e di cui si revocano i token come con «Rigenera token» e si azzerano le richieste e lo stato del Mac vecchio
 * (disinstallazione, diagnosi, aggiornamento fallito, tipo, stato di Claude). La richiesta passa a `approved` legata all'utente e
 * al nodo; il token lo crea il `poll`. Errori di nome o di nodo contano come tentativi falliti (5 → `expired`).
 */
export async function approvePairing(
  userId: number,
  userCode: string,
  input: { name: string; replaceNodeId?: number | null },
  now: Date = new Date(),
): Promise<void> {
  const open = await findOpen(userCode, now);
  try {
    const stopped = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(nodePairingsTable)
        .where(and(eq(nodePairingsTable.id, open.id), eq(nodePairingsTable.status, "pending"), gt(nodePairingsTable.expiresAt, now)))
        .for("update");
      if (!row) throw new PairingError(404, PAIRING_MESSAGES.notFound);
      let nodeId: number;
      let work = null;
      if (input.replaceNodeId != null) {
        const [node] = await tx
          .select()
          .from(nodesTable)
          .where(and(eq(nodesTable.id, input.replaceNodeId), eq(nodesTable.userId, userId), eq(nodesTable.status, "active")))
          .for("update");
        if (!node) throw new PairingError(404, NODE_MESSAGES.notFound);
        nodeId = node.id;
        work = await revokeNodeTokens(tx, node.id);
        // Il Mac nuovo non eredita le richieste e lo stato del vecchio (disinstallazione, diagnosi, aggiornamento fallito, Claude)
        await tx
          .update(nodesTable)
          .set({ uninstallRequestedAt: null, diagnosticsRequestedAt: null, updateFailedVersion: null, kind: null, claudeStatus: null, claudeCheckedAt: null })
          .where(eq(nodesTable.id, node.id));
      } else {
        const [created] = await tx.insert(nodesTable).values({ userId, name: cleanNodeName(input.name) }).returning({ id: nodesTable.id });
        nodeId = created!.id;
      }
      // Il nodo deve avere il tempo di ritirare il token anche se si approva a ridosso della scadenza
      const collectBy = new Date(now.getTime() + COLLECT_GRACE_MS);
      const expiresAt = row.expiresAt.getTime() < collectBy.getTime() ? collectBy : row.expiresAt;
      await tx.update(nodePairingsTable).set({ status: "approved", userId, nodeId, decidedAt: now, expiresAt }).where(eq(nodePairingsTable.id, row.id));
      return work;
    });
    if (stopped) await notifyStopped(stopped);
  } catch (err) {
    const mapped = isUniqueViolation(err, "nodes_user_name_unique") ? new NodeNameConflictError() : err;
    if (mapped instanceof NodeInputError || mapped instanceof NodeNameConflictError || (mapped instanceof PairingError && mapped.message === NODE_MESSAGES.notFound)) {
      await recordFailure(open.userCodeHash);
    }
    throw mapped;
  }
}

/** Rifiuta la richiesta: il `poll` risponderà 410. */
export async function denyPairing(userId: number, userCode: string, now: Date = new Date()): Promise<void> {
  const open = await findOpen(userCode, now);
  const [done] = await db
    .update(nodePairingsTable)
    .set({ status: "denied", userId, decidedAt: now })
    .where(and(eq(nodePairingsTable.id, open.id), eq(nodePairingsTable.status, "pending")))
    .returning({ id: nodePairingsTable.id });
  if (!done) throw new PairingError(404, PAIRING_MESSAGES.notFound);
}

/** Cancella le richieste create da oltre 1 ora, in qualunque stato (il collegamento resta in `nodes.paired_at`); restituisce quante. */
export async function purgeNodePairings(now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(nodePairingsTable)
    .where(lt(nodePairingsTable.createdAt, new Date(now.getTime() - PAIRING_RETENTION_MS)))
    .returning({ id: nodePairingsTable.id });
  return rows.length;
}
