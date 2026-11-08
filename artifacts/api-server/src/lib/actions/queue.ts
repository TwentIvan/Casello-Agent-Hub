import { db, pendingActionStepsTable, pendingActionsTable } from "@workspace/db";
import { and, count, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "../pg-errors";
import { encryptSecret } from "../secrets";
import { maskArgsWithSchema } from "../tools/sensitive";
import type { CatalogTool } from "../tools/types";
import type { ProposalInput } from "./proposal";
import { checkQueuedText } from "./text-check";

// Coda delle azioni L2: una chiamata a uno strumento che richiede conferma non si esegue, diventa una
// voce `pending` con un numero progressivo per utente. Gli argomenti si salvano cifrati (per
// l'esecuzione all'approvazione) e oscurati (per mostrarli). L'esecuzione e la decisione stanno altrove.

export const MAX_PENDING_PER_USER = 50;
export const TOO_MANY_PENDING_MESSAGE = "troppe azioni in attesa di conferma";

// Tentativi di numerazione: due accodamenti concorrenti dello stesso utente possono leggere lo stesso
// massimo; il secondo viola l'unico (user_id, number) e riprova con il numero successivo
const NUMBER_ATTEMPTS = 5;
const NUMBER_CONSTRAINT = "pending_actions_user_number_unique";

export type EnqueueResult = { ok: true; number: number } | { ok: false; message: string };

export interface EnqueueInput {
  userId: number;
  appId: number;
  agentId: number | null;
  runId: number | null;
  tool: CatalogTool;
  args: Record<string, unknown>;
  recipient: string;
  summary: string;
  teamInstanceId?: number | null;
}

export async function enqueueAction(input: EnqueueInput): Promise<EnqueueResult> {
  // Controllo sugli argomenti oscurati: i valori x-sensitive non si controllano né si citano nei problemi
  const argsPublic = maskArgsWithSchema(input.tool.paramsSchema, input.args);
  const checked = argsPublic !== null && typeof argsPublic === "object" ? (argsPublic as Record<string, unknown>) : {};
  const problems = checkQueuedText({ recipient: input.recipient, summary: input.summary, args: checked });
  if (problems.length > 0) return { ok: false, message: `testo non pronto: ${problems.join("; ")}` };

  const argsEnc = encryptSecret(JSON.stringify(input.args));
  return insertQueued(input.userId, {
    appId: input.appId,
    toolId: input.tool.id,
    runId: input.runId,
    agentId: input.agentId,
    teamInstanceId: input.teamInstanceId ?? null,
    argsEnc,
    argsPublic,
    recipient: input.recipient,
    summary: input.summary,
  });
}

type QueuedValues = Omit<typeof pendingActionsTable.$inferInsert, "userId" | "number">;

/** Esecutore delle scritture in coda: il pool o una transazione aperta dal chiamante. */
export type QueueExecutor = Pick<typeof db, "select" | "insert" | "transaction">;

/**
 * Limite per utente e numerazione progressiva (con nuovo tentativo sull'unico), uguali per ogni tipo di voce. Dentro
 * una transazione del chiamante ogni tentativo d'inserimento è un savepoint: una violazione dell'unico non annulla
 * la transazione intera.
 */
async function insertQueued(userId: number, values: QueuedValues, executor: QueueExecutor = db): Promise<EnqueueResult> {
  const [pending] = await executor
    .select({ n: count() })
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.status, "pending")));
  if (Number(pending?.n ?? 0) >= MAX_PENDING_PER_USER) return { ok: false, message: TOO_MANY_PENDING_MESSAGE };

  for (let attempt = 1; ; attempt++) {
    try {
      const insert = (ex: QueueExecutor) =>
        ex
          .insert(pendingActionsTable)
          .values({
            ...values,
            userId,
            // Numero letto e scritto nella stessa istruzione: il massimo dell'utente + 1
            number: sql`(select coalesce(max(${pendingActionsTable.number}), 0) + 1 from ${pendingActionsTable} where ${pendingActionsTable.userId} = ${userId})`,
          })
          .returning({ number: pendingActionsTable.number });
      const [row] = executor === db ? await insert(db) : await executor.transaction((sp) => insert(sp));
      return { ok: true, number: row!.number };
    } catch (err) {
      if (attempt < NUMBER_ATTEMPTS && isUniqueViolation(err, NUMBER_CONSTRAINT)) continue;
      throw err;
    }
  }
}

export interface EnqueuePlanInput {
  userId: number;
  instanceId: number;
  kind: "plan" | "plan_change";
  planVersion: number;
  /** Nome della squadra. */
  recipient: string;
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * Accoda un piano (o una modifica del piano) proposto dal capo di una squadra: stessa coda e numerazione delle azioni.
 * Con `executor` l'inserimento avviene nella transazione del chiamante (insieme alla versione del PLAN).
 */
export async function enqueuePlanItem(input: EnqueuePlanInput, executor: QueueExecutor = db): Promise<EnqueueResult> {
  return insertQueued(input.userId, {
    kind: input.kind,
    teamInstanceId: input.instanceId,
    planVersion: input.planVersion,
    argsEnc: encryptSecret(JSON.stringify(input.detail)),
    argsPublic: input.detail,
    recipient: input.recipient,
    summary: input.summary,
  }, executor);
}

export interface EnqueueProposalInput {
  userId: number;
  appId: number;
  agentId: number;
  runId: number;
  /** Nome dell'app. */
  recipient: string;
  proposal: ProposalInput;
  /** Proposta con gli argomenti `x-sensitive` oscurati. */
  publicProposal: Record<string, unknown>;
  steps: { key: string; position: number; toolId: number; summary: string }[];
}

/**
 * Accoda una proposta con più passi: voce `proposal` (stessa coda, limite e numerazione delle azioni) e una riga per
 * passo, nella stessa transazione. Gli argomenti stanno solo in `args_enc`, cifrati.
 */
export async function enqueueProposal(input: EnqueueProposalInput): Promise<EnqueueResult> {
  return db.transaction(async (tx) => {
    const queued = await insertQueued(
      input.userId,
      {
        kind: "proposal",
        appId: input.appId,
        toolId: null,
        agentId: input.agentId,
        runId: input.runId,
        argsEnc: encryptSecret(JSON.stringify(input.proposal)),
        argsPublic: input.publicProposal,
        recipient: input.recipient,
        summary: input.proposal.title,
      },
      tx,
    );
    if (!queued.ok) return queued;
    const [row] = await tx
      .select({ id: pendingActionsTable.id })
      .from(pendingActionsTable)
      .where(and(eq(pendingActionsTable.userId, input.userId), eq(pendingActionsTable.number, queued.number)))
      .limit(1);
    await tx.insert(pendingActionStepsTable).values(
      input.steps.map((s) => ({ pendingActionId: row!.id, key: s.key, position: s.position, toolId: s.toolId, summary: s.summary })),
    );
    return queued;
  });
}
