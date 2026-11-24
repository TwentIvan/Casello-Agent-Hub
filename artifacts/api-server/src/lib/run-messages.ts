// Istruire una run in corso (issue #119): l'utente manda un'istruzione a una run `running`; il ciclo dell'agente la legge
// tra un passo e l'altro (`takeRunInstructions`) e la inserisce come messaggio dell'utente prima della chiamata
// successiva al modello. L'istruzione non concede permessi: i tool L2 restano in «Da confermare» e gli L3 non si
// offrono (il ciclo non cambia gli strumenti). Le istruzioni passano dal DB: la consegna vale anche se la run gira in un
// altro processo. Quelle non consegnate alla fine della run diventano `dropped`.

import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db, runMessagesTable, runsTable, type RunMessageRow } from "@workspace/db";
import { isNodeModel } from "./ai/node-account";
import type { UserInstruction } from "./agent-loop";
import { publishRunChange } from "./live/events";

/** Lunghezza massima di un'istruzione. */
export const RUN_MESSAGE_MAX_CHARS = 2_000;
/** Istruzioni in attesa di consegna per run. */
export const RUN_MESSAGE_MAX_PENDING = 5;
/** Istruzioni in tutto per run (consegnate comprese): un freno ai giri senza fine. */
export const RUN_MESSAGE_MAX_TOTAL = 20;

export const RUN_MESSAGE_MESSAGES = {
  runNotFound: "Esecuzione non trovata",
  notRunning: "la run non è in corso: le istruzioni si mandano solo a una run in esecuzione",
  nodeRun: "la run è eseguita da Claude Code sul nodo: non riceve istruzioni durante il turno",
  empty: "istruzione vuota",
  tooLong: `istruzione troppo lunga: al massimo ${RUN_MESSAGE_MAX_CHARS} caratteri`,
  tooManyPending: `troppe istruzioni in attesa: aspetta che la run consegni le ${RUN_MESSAGE_MAX_PENDING} già mandate`,
  tooMany: `limite di ${RUN_MESSAGE_MAX_TOTAL} istruzioni per run raggiunto`,
} as const;

export type CreateRunMessageResult =
  | { kind: "created"; message: RunMessageRow }
  | { kind: "not_found" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string };

/** Testo dell'istruzione ripulito: caratteri di controllo tolti (restano a capo e tabulazione), spazi ai bordi tolti. */
export function cleanInstruction(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

/**
 * Accoda un'istruzione per una run `running` eseguita dal ciclo cloud. Conteggi e inserimento con la riga della run
 * bloccata: due invii insieme non superano i limiti, e una run che finisce nel frattempo non riceve la voce.
 */
export async function createRunMessage(runId: number, userId: number | null, text: string): Promise<CreateRunMessageResult> {
  const content = cleanInstruction(text);
  if (content.length === 0) return { kind: "invalid", message: RUN_MESSAGE_MESSAGES.empty };
  if (content.length > RUN_MESSAGE_MAX_CHARS) return { kind: "invalid", message: RUN_MESSAGE_MESSAGES.tooLong };

  const [run] = await db
    .select({ id: runsTable.id, status: runsTable.status, aiModelId: runsTable.aiModelId })
    .from(runsTable)
    .where(eq(runsTable.id, runId))
    .limit(1);
  if (!run) return { kind: "not_found" };
  if (run.status !== "running") return { kind: "conflict", message: RUN_MESSAGE_MESSAGES.notRunning };
  // Claude Code sul nodo esegue tutto il turno in una volta: non c'è un «tra un passo e l'altro» da cui leggere
  if (run.aiModelId !== null && (await isNodeModel(run.aiModelId))) {
    return { kind: "conflict", message: RUN_MESSAGE_MESSAGES.nodeRun };
  }

  const result = await db.transaction(async (tx): Promise<CreateRunMessageResult> => {
    const [locked] = await tx
      .select({ status: runsTable.status, agentId: runsTable.agentId })
      .from(runsTable)
      .where(eq(runsTable.id, runId))
      .for("update");
    if (!locked) return { kind: "not_found" };
    if (locked.status !== "running") return { kind: "conflict", message: RUN_MESSAGE_MESSAGES.notRunning };
    const rows = await tx
      .select({ status: runMessagesTable.status, n: count() })
      .from(runMessagesTable)
      .where(eq(runMessagesTable.runId, runId))
      .groupBy(runMessagesTable.status);
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    const pending = Number(rows.find((r) => r.status === "pending")?.n ?? 0);
    if (total >= RUN_MESSAGE_MAX_TOTAL) return { kind: "conflict", message: RUN_MESSAGE_MESSAGES.tooMany };
    if (pending >= RUN_MESSAGE_MAX_PENDING) return { kind: "conflict", message: RUN_MESSAGE_MESSAGES.tooManyPending };
    const [message] = await tx.insert(runMessagesTable).values({ runId, userId, content }).returning();
    return { kind: "created", message };
  });
  if (result.kind === "created") publishRunChange(runId, null);
  return result;
}

/** Istruzioni di una run, dalla prima. */
export async function listRunMessages(runId: number): Promise<RunMessageRow[]> {
  return db
    .select()
    .from(runMessagesTable)
    .where(eq(runMessagesTable.runId, runId))
    .orderBy(asc(runMessagesTable.id));
}

/**
 * Prende le istruzioni in attesa e le segna consegnate con un solo UPDATE condizionato (ognuna arriva al modello una
 * volta sola), in ordine di invio.
 */
export async function takeRunInstructions(runId: number, agentId: number | null): Promise<UserInstruction[]> {
  const rows = await db
    .update(runMessagesTable)
    .set({ status: "delivered", deliveredAt: new Date() })
    .where(and(eq(runMessagesTable.runId, runId), eq(runMessagesTable.status, "pending")))
    .returning({ id: runMessagesTable.id, content: runMessagesTable.content });
  if (rows.length > 0) publishRunChange(runId, agentId);
  return rows.sort((a, b) => a.id - b.id);
}

/** Alla fine della run le istruzioni non consegnate diventano `dropped`. */
export async function dropPendingRunMessages(runIds: number[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const rows = await db
    .update(runMessagesTable)
    .set({ status: "dropped" })
    .where(and(inArray(runMessagesTable.runId, runIds), eq(runMessagesTable.status, "pending")))
    .returning({ id: runMessagesTable.id });
  return rows.length;
}
