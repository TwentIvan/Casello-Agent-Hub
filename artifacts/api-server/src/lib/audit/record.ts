import type { Request, RequestHandler } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import { auditEventsTable, db, type AuditEvent } from "@workspace/db";
import { logger } from "../logger";
import { looksLikeCredential } from "../memory/credentials";
import { auditEventFor, matchAuditRoute, type AuditDetail, type AuditDetailValue } from "./actions";

// Registro delle azioni (issue #115): scrittura degli eventi, lettura per l'utente e pulizia.
// La scrittura non fallisce mai la richiesta: un errore si registra nel log (solo il nome) e l'evento si perde.

export type AuditVia = "session" | "token" | "embed" | "mcp" | "alfred" | "system";

export interface AuditInput {
  userId: number;
  action: string;
  objectType?: string | null;
  objectId?: string | number | null;
  detail?: AuditDetail | null;
  via: AuditVia;
  tokenId?: number | null;
  ip?: string | null;
}

/** Giorni di conservazione degli eventi */
export const AUDIT_RETENTION_DAYS = 365;
/** Eventi per pagina nella lettura */
export const AUDIT_PAGE_MAX = 100;

const MAX_STRING = 100;
const MAX_LIST = 10;

function cleanString(value: string): string | null {
  const s = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_STRING);
  // Ultima difesa: un valore che sembra una credenziale non entra mai
  return looksLikeCredential(s) ? "***" : s;
}

/** Dettaglio ripulito: solo valori semplici, stringhe corte e senza credenziali, al più 10 campi. */
export function cleanDetail(detail: AuditDetail | null | undefined): AuditDetail | null {
  if (!detail) return null;
  const out: AuditDetail = {};
  for (const [key, value] of Object.entries(detail).slice(0, 10)) {
    let v: AuditDetailValue;
    if (typeof value === "string") v = cleanString(value);
    else if (Array.isArray(value)) v = value.slice(0, MAX_LIST).map((x) => cleanString(String(x)) ?? "");
    else if (typeof value === "number") v = Number.isFinite(value) ? value : null;
    else if (typeof value === "boolean" || value === null) v = value;
    else continue;
    out[key.slice(0, 40)] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const objectId = input.objectId === null || input.objectId === undefined ? null : cleanString(String(input.objectId));
    await db.insert(auditEventsTable).values({
      userId: input.userId,
      action: input.action.slice(0, 80),
      objectType: input.objectType ? input.objectType.slice(0, 40) : null,
      objectId,
      detail: cleanDetail(input.detail),
      via: input.via,
      tokenId: input.tokenId ?? null,
      ip: input.ip ? input.ip.slice(0, 64) : null,
    });
  } catch (err) {
    logger.error(
      { action: input.action, errName: err instanceof Error ? err.name : "unknown" },
      "Evento del registro delle azioni non salvato",
    );
  }
}

/** Canale, token e IP della richiesta (dopo requireAuth). */
export function auditContext(req: Request): { via: AuditVia; tokenId: number | null; ip: string | null } {
  const auth = req.auth;
  const ip = req.ip ?? null;
  if (auth?.kind === "token") return { via: auth.via === "embed" ? "embed" : "token", tokenId: auth.tokenId, ip };
  return { via: "session", tokenId: null, ip };
}

/**
 * Middleware montato dopo requireAuth: per le route del registro (AUDIT_ROUTES) scrive un evento quando la risposta
 * è 2xx. La risposta JSON si tiene solo in memoria per leggere l'id creato, mai salvata.
 */
export function auditRoutes(): RequestHandler {
  return (req, res, next) => {
    const match = matchAuditRoute(req.method, req.path);
    if (!match) {
      next();
      return;
    }
    let payload: unknown;
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      payload = body;
      return json(body);
    }) as typeof res.json;
    res.on("finish", () => {
      const userId = req.userId;
      if (userId === undefined || res.statusCode < 200 || res.statusCode >= 300) return;
      const event = auditEventFor(match, req.body, payload);
      payload = undefined;
      void recordAudit({ userId, ...event, ...auditContext(req) });
    });
    next();
  };
}

export interface AuditEventView {
  id: number;
  action: string;
  objectType: string | null;
  objectId: string | null;
  detail: AuditDetail | null;
  via: string;
  tokenId: number | null;
  ip: string | null;
  createdAt: Date;
}

function toView(row: AuditEvent): AuditEventView {
  return {
    id: row.id,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    detail: row.detail ?? null,
    via: row.via,
    tokenId: row.tokenId,
    ip: row.ip,
    createdAt: row.createdAt,
  };
}

/** Eventi dell'utente, i più recenti per primi; `before` = id dell'ultimo evento della pagina precedente. */
export async function listAuditEvents(userId: number, opts: { limit?: number; before?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), AUDIT_PAGE_MAX);
  const rows = await db
    .select()
    .from(auditEventsTable)
    .where(
      opts.before !== undefined
        ? and(eq(auditEventsTable.userId, userId), lt(auditEventsTable.id, opts.before))
        : eq(auditEventsTable.userId, userId),
    )
    .orderBy(desc(auditEventsTable.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map(toView);
  return { events: page, nextBefore: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
}

/** Cancella gli eventi più vecchi della conservazione. */
export async function sweepAuditEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.delete(auditEventsTable).where(lt(auditEventsTable.createdAt, cutoff)).returning({ id: auditEventsTable.id });
  return rows.length;
}

const SWEEP_MS = 24 * 60 * 60 * 1000;

/** Pulizia 5 minuti dopo l'avvio e poi una volta al giorno. */
export function startAuditSweeper(): void {
  const run = () => {
    sweepAuditEvents()
      .then((count) => {
        if (count > 0) logger.info({ count }, "Eventi vecchi del registro delle azioni cancellati");
      })
      .catch((err: unknown) =>
        logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Pulizia del registro delle azioni non riuscita"),
      );
  };
  setTimeout(run, 5 * 60 * 1000).unref();
  setInterval(run, SWEEP_MS).unref();
}
