// «Ferma», «Invia subito» e «Accoda» comuni alle tre chat (spec 2026-11-10 ferma-skill-esegui §1). Un turno che gira in
// questo processo si interrompe con il suo segnale (`abortTurn`) e si chiude da solo con «Risposta interrotta.»; un
// turno che non gira qui (altro container, riavvio) si chiude direttamente nel DB. Il messaggio in coda è una riga del
// messaggio utente con `queued_at` non nullo (al più una per conversazione, indice unico parziale): parte quando il
// turno in corso finisce (`drainQueued`).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { abortTurn, liveTurnId } from "../stale-turns";
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
 * dell'assistente ancora vuoto → «Risposta interrotta.» (non è un errore). True se la conversazione era `running`; su una conversazione già ferma non si tocca nulla. Se ha
 * chiuso il turno, annulla i turni del nodo ancora aperti del suo messaggio dell'assistente.
 */
export async function closeTurnAsStopped(spec: ChatKindSpec, conversationId: number, expectedAssistantId?: number): Promise<boolean> {
  // Con `expectedAssistantId` si chiude solo il turno di quel messaggio: ancora vuoto e ultimo dell'assistente
  const sameTurn =
    expectedAssistantId === undefined
      ? sql`true`
      : sql`exists (
          select 1 from ${msgTable(spec)} m
           where m.id = ${expectedAssistantId} and m.conversation_id = ${conversationId} and m.role = 'assistant' and m.content = ''
             and not exists (
               select 1 from ${msgTable(spec)} m2
                where m2.conversation_id = ${conversationId} and m2.role = 'assistant' and m2.id > m.id
             )
        )`;
  // Id del messaggio dell'assistente del turno chiuso (l'ultimo), o null se non si è chiuso nulla
  const closedAssistantId = await db.transaction(async (tx): Promise<number | null> => {
    const conv = await tx.execute(sql`
      update ${convTable(spec)}
         set turn_status = 'idle', updated_at = now()
       where id = ${conversationId} and turn_status = 'running' and ${sameTurn}
      returning id`);
    // Conversazione già ferma: l'ultimo messaggio vuoto non è del turno da chiudere
    if (conv.rows.length === 0) return null;
    const last = await tx.execute(sql`
      select id from ${msgTable(spec)}
       where conversation_id = ${conversationId} and role = 'assistant'
       order by id desc
       limit 1`);
    const lastId = (last.rows[0] as { id?: number } | undefined)?.id;
    if (lastId === undefined) return 0;
    await tx.execute(sql`
      update ${msgTable(spec)}
         set content = ${STOPPED_TURN_MESSAGE}, error = false
       where id = ${lastId} and content = ''`);
    return Number(lastId);
  });
  if (closedAssistantId === null) return false;
  // Solo i turni del nodo del messaggio chiuso: un turno nuovo della stessa conversazione (es. partito in un altro
  // processo durante un deploy) non si tocca. 0 = nessun messaggio dell'assistente, quindi nessun turno del nodo.
  if (closedAssistantId > 0) await cancelOpenTurnsFor(spec.consumer, conversationId, closedAssistantId);
  return true;
}

/**
 * Il turno è ancora aperto: conversazione `running` e messaggio dell'assistente del turno ancora vuoto. Falso se il
 * turno è stato chiuso nel DB (Ferma, turni appesi) prima che partisse davvero in questo processo.
 */
export async function isTurnOpen(spec: ChatKindSpec, conversationId: number, assistantMessageId: number): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from ${convTable(spec)} c
      join ${msgTable(spec)} m on m.conversation_id = c.id
     where c.id = ${conversationId} and c.turn_status = 'running'
       and m.id = ${assistantMessageId} and m.role = 'assistant' and m.content = ''`);
  return result.rows.length > 0;
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
export async function stopChatTurn(
  spec: ChatKindSpec,
  conversationId: number,
  opts: { expectedAssistantId?: number } = {},
): Promise<boolean> {
  const expected = opts.expectedAssistantId;
  // Il messaggio del turno da fermare (l'ultimo dell'assistente, o quello atteso) prima dell'interruzione
  const last = await db.execute(sql`
    select id from ${msgTable(spec)}
     where conversation_id = ${conversationId} and role = 'assistant'
     order by id desc
     limit 1`);
  const messageId = expected ?? (last.rows[0] as { id?: number } | undefined)?.id ?? null;
  // Turno vivo qui ma diverso da quello atteso (es. già partito con il messaggio accodato): non si ferma
  const liveId = liveTurnId(spec.kind, conversationId);
  if (expected !== undefined && liveId !== undefined && liveId !== expected) return false;
  if (abortTurn(spec.kind, conversationId)) {
    const deadline = Date.now() + STOP_WAIT_MS;
    let closed = false;
    while (Date.now() < deadline) {
      const state = await readState(spec, conversationId, messageId);
      if (state.idle || state.filled) {
        closed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
    if (!closed) logger.warn({ kind: spec.kind, conversationId }, "Turno fermato non ancora chiuso dopo 10 s");
    return true;
  }
  const closed = await closeTurnAsStopped(spec, conversationId, expected);
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
    // Solo se il testo è ancora quello avviato: un «Accoda» arrivato nel frattempo ha sostituito il messaggio, che resta
    // in coda e parte alla fine del turno appena avviato
    await db.execute(
      sql`delete from ${msgTable(spec)} where id = ${queued.id} and queued_at is not null and content = ${queued.content}`,
    );
  } catch (err) {
    logger.warn({ kind: spec.kind, conversationId, errName: err instanceof Error ? err.name : "unknown" }, "Coda della conversazione non elaborata");
  }
}

/** Modo di invio di un messaggio: `normal` avvia il turno, `queue` lo mette in coda a un turno in corso, `now` lo mette in coda e ferma il turno. */
export type ChatSendMode = "normal" | "now" | "queue";

export type ChatSendOutcome<M> = { kind: "started"; message: M } | { kind: "queued"; queued: QueuedMessage };

async function isRunning(spec: ChatKindSpec, conversationId: number): Promise<boolean> {
  const conv = await db.execute(sql`select turn_status from ${convTable(spec)} where id = ${conversationId}`);
  return (conv.rows[0] as { turn_status?: string } | undefined)?.turn_status === "running";
}

/** Id del messaggio dell'assistente del turno in corso (l'ultimo), o null se la conversazione non è `running`. */
async function runningTurnId(spec: ChatKindSpec, conversationId: number): Promise<number | null> {
  const result = await db.execute(sql`
    select (select m.id from ${msgTable(spec)} m
             where m.conversation_id = c.id and m.role = 'assistant'
             order by m.id desc limit 1) as assistant_id
      from ${convTable(spec)} c
     where c.id = ${conversationId} and c.turn_status = 'running'`);
  const row = result.rows[0] as { assistant_id?: number | null } | undefined;
  return row?.assistant_id == null ? null : Number(row.assistant_id);
}

const isTurnBusy = (err: unknown): boolean => err instanceof Error && err.name === "TurnBusyError";

/**
 * Invio di un messaggio con il suo modo (le validazioni e i limiti della route vengono prima). `normal`: `start`, un
 * turno in corso dà `TurnBusyError` come sempre. `queue` e `now`: senza turno in corso si avvia come `normal`; con un
 * turno in corso (anche scoperto da un `TurnBusyError`) il messaggio va in coda e, con `now`, il turno si ferma. Se il
 * turno è finito prima che il messaggio entrasse in coda, la coda si svuota subito.
 */
export async function sendChatMessage<M>(
  spec: ChatKindSpec,
  conversationId: number,
  content: string,
  page: PageContext | null,
  mode: ChatSendMode,
  start: () => Promise<M>,
): Promise<ChatSendOutcome<M>> {
  if (mode === "normal") return { kind: "started", message: await start() };
  // Il turno da fermare si fissa PRIMA dell'inserimento in coda: se nel frattempo finisce e parte il turno del
  // messaggio accodato, «Invia subito» non deve fermare quello
  let turnId = await runningTurnId(spec, conversationId);
  if (turnId === null && !(await isRunning(spec, conversationId))) {
    try {
      return { kind: "started", message: await start() };
    } catch (err) {
      // Un turno partito nel frattempo: il messaggio va in coda
      if (!isTurnBusy(err)) throw err;
      turnId = await runningTurnId(spec, conversationId);
    }
  }
  const queued = await queueChatMessage(spec, conversationId, content, page);
  // Senza un messaggio dell'assistente (turno appena preso, non ancora scritto) non c'è un turno sicuro da fermare
  if (mode === "now" && turnId !== null) await stopChatTurn(spec, conversationId, { expectedAssistantId: turnId });
  // Turno finito prima dell'inserimento in coda (o fermato senza svuotare): nessuno farebbe partire il messaggio
  if (!(await isRunning(spec, conversationId))) await drainQueued(spec, conversationId);
  return { kind: "queued", queued };
}
