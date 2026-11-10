// «Ferma», «Invia subito» e «Accoda» comuni alle tre chat (spec 2026-11-10 ferma-skill-esegui §1). Un turno che gira in
// questo processo si interrompe con il suo segnale (`abortTurn`) e si chiude da solo con «Risposta interrotta.»; un
// turno che non gira qui (altro container, riavvio) si chiude direttamente nel DB. Il messaggio in coda è una riga del
// messaggio utente con `queued_at` non nullo (al più una per conversazione, indice unico parziale): parte quando il
// turno in corso finisce (`drainQueued`).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { abortTurn } from "../stale-turns";
import { cancelOpenTurnsFor } from "../node-turns/queue";
import { STOPPED_TURN_MESSAGE } from "../plan-chat/turn";
import type { PageContext } from "../characters/types";
import type { ChatKindSpec } from "./spec";

export interface QueuedMessage {
  id: number;
  content: string;
  createdAt: Date;
}

/** Attesa massima che un turno interrotto in questo processo si chiuda da solo. */
const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 100;

const convTable = (spec: ChatKindSpec) => sql.identifier(spec.conversationsTable);
const msgTable = (spec: ChatKindSpec) => sql.identifier(spec.messagesTable);

/** Date delle letture SQL grezze: `timestamp` senza fuso, salvato in UTC come fa Drizzle. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = String(value);
  return new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
}

/**
 * Chiude nel DB un turno che non gira in questo processo: conversazione `running` → `idle`, ultimo messaggio
 * dell'assistente ancora vuoto → «Risposta interrotta.» (non è un errore). True se qualcosa è cambiato. Poi annulla i
 * turni del nodo ancora aperti della conversazione.
 */
export async function closeTurnAsStopped(spec: ChatKindSpec, conversationId: number): Promise<boolean> {
  const changed = await db.transaction(async (tx) => {
    const conv = await tx.execute(sql`
      update ${convTable(spec)}
         set turn_status = 'idle', updated_at = now()
       where id = ${conversationId} and turn_status = 'running'
      returning id`);
    const msg = await tx.execute(sql`
      update ${msgTable(spec)}
         set content = ${STOPPED_TURN_MESSAGE}, error = false
       where id = (
               select id from ${msgTable(spec)}
                where conversation_id = ${conversationId} and role = 'assistant'
                order by id desc
                limit 1
             )
         and content = ''
      returning id`);
    return conv.rows.length > 0 || msg.rows.length > 0;
  });
  await cancelOpenTurnsFor(spec.consumer, conversationId);
  return changed;
}

async function readState(spec: ChatKindSpec, conversationId: number, messageId: number | null): Promise<{ idle: boolean; filled: boolean }> {
  const conv = await db.execute(sql`select turn_status from ${convTable(spec)} where id = ${conversationId}`);
  const status = (conv.rows[0] as { turn_status?: string } | undefined)?.turn_status;
  let filled = false;
  if (messageId !== null) {
    const msg = await db.execute(sql`select content from ${msgTable(spec)} where id = ${messageId}`);
    const content = (msg.rows[0] as { content?: string } | undefined)?.content;
    filled = content === undefined || content !== "";
  }
  return { idle: status === undefined || status === "idle", filled };
}

/**
 * «Ferma»: interrompe il turno della conversazione. Se gira in questo processo attende (al più 10 s) che si chiuda da
 * solo e risponde true; altrimenti lo chiude nel DB e, se c'era qualcosa da chiudere, fa partire il messaggio in coda.
 * False se non c'era nessun turno da fermare.
 */
export async function stopChatTurn(spec: ChatKindSpec, conversationId: number): Promise<boolean> {
  // Il messaggio del turno da fermare (l'ultimo dell'assistente) prima dell'interruzione
  const last = await db.execute(sql`
    select id from ${msgTable(spec)}
     where conversation_id = ${conversationId} and role = 'assistant'
     order by id desc
     limit 1`);
  const messageId = (last.rows[0] as { id?: number } | undefined)?.id ?? null;
  if (abortTurn(spec.kind, conversationId)) {
    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      const state = await readState(spec, conversationId, messageId);
      if (state.idle || state.filled) break;
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
    return true;
  }
  const closed = await closeTurnAsStopped(spec, conversationId);
  if (closed) await drainQueued(spec, conversationId);
  return closed;
}

/**
 * «Accoda»: salva (o sostituisce) il messaggio in coda della conversazione. `queued_at` resta quello della prima
 * inserzione; testo e pagina diventano quelli nuovi.
 */
export async function queueChatMessage(
  spec: ChatKindSpec,
  conversationId: number,
  content: string,
  page: PageContext | null,
): Promise<QueuedMessage> {
  const result = spec.hasPageContext
    ? await db.execute(sql`
        insert into ${msgTable(spec)} (conversation_id, role, content, page_context, queued_at)
        values (${conversationId}, 'user', ${content}, ${page === null ? null : JSON.stringify(page)}::jsonb, now())
        on conflict (conversation_id) where queued_at is not null
        do update set content = excluded.content, page_context = excluded.page_context
        returning id, content, created_at`)
    : await db.execute(sql`
        insert into ${msgTable(spec)} (conversation_id, role, content, queued_at)
        values (${conversationId}, 'user', ${content}, now())
        on conflict (conversation_id) where queued_at is not null
        do update set content = excluded.content
        returning id, content, created_at`);
  const row = result.rows[0] as { id: number; content: string; created_at: unknown };
  return { id: Number(row.id), content: row.content, createdAt: toDate(row.created_at) };
}

/** Toglie il messaggio in coda della conversazione (se c'è). */
export async function cancelQueued(spec: ChatKindSpec, conversationId: number): Promise<void> {
  await db.execute(sql`delete from ${msgTable(spec)} where conversation_id = ${conversationId} and queued_at is not null`);
}

async function readQueued(spec: ChatKindSpec, conversationId: number): Promise<(QueuedMessage & { page: PageContext | null }) | null> {
  const result = spec.hasPageContext
    ? await db.execute(sql`
        select id, content, created_at, page_context from ${msgTable(spec)}
         where conversation_id = ${conversationId} and queued_at is not null
         limit 1`)
    : await db.execute(sql`
        select id, content, created_at, null as page_context from ${msgTable(spec)}
         where conversation_id = ${conversationId} and queued_at is not null
         limit 1`);
  const row = result.rows[0] as { id: number; content: string; created_at: unknown; page_context: unknown } | undefined;
  if (!row) return null;
  const raw = typeof row.page_context === "string" ? (JSON.parse(row.page_context) as unknown) : row.page_context;
  const page = raw && typeof raw === "object" ? (raw as PageContext) : null;
  return { id: Number(row.id), content: row.content, createdAt: toDate(row.created_at), page };
}

/** Il messaggio in coda della conversazione, o null. */
export async function getQueued(spec: ChatKindSpec, conversationId: number): Promise<QueuedMessage | null> {
  const queued = await readQueued(spec, conversationId);
  return queued ? { id: queued.id, content: queued.content, createdAt: queued.createdAt } : null;
}

/** Errori dopo i quali il messaggio resta in coda senza avvisi: turno ancora occupato o regola della chat (4xx). */
function isExpectedRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TurnBusyError") return true;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Fa partire il messaggio in coda (se c'è) come nuovo turno e, riuscito, toglie la riga in coda. Se il turno non
 * parte la riga resta (l'utente la vede ancora in coda). Non lancia mai.
 */
export async function drainQueued(spec: ChatKindSpec, conversationId: number): Promise<void> {
  try {
    const queued = await readQueued(spec, conversationId);
    if (!queued) return;
    try {
      await spec.start(conversationId, queued.content, queued.page);
    } catch (err) {
      if (!isExpectedRefusal(err)) {
        logger.warn({ kind: spec.kind, conversationId, errName: err instanceof Error ? err.name : "unknown" }, "Messaggio in coda non avviato");
      }
      return;
    }
    await db.execute(sql`delete from ${msgTable(spec)} where id = ${queued.id} and queued_at is not null`);
  } catch (err) {
    logger.warn({ kind: spec.kind, conversationId, errName: err instanceof Error ? err.name : "unknown" }, "Coda della conversazione non elaborata");
  }
}
