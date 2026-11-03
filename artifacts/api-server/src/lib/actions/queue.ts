import { db, pendingActionsTable } from "@workspace/db";
import { and, count, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "../pg-errors";
import { encryptSecret } from "../secrets";
import { maskArgsWithSchema } from "../tools/sensitive";
import type { CatalogTool } from "../tools/types";
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
}

export async function enqueueAction(input: EnqueueInput): Promise<EnqueueResult> {
  const problems = checkQueuedText({ recipient: input.recipient, summary: input.summary, args: input.args });
  if (problems.length > 0) return { ok: false, message: `testo non pronto: ${problems.join("; ")}` };

  const [pending] = await db
    .select({ n: count() })
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, input.userId), eq(pendingActionsTable.status, "pending")));
  if (Number(pending?.n ?? 0) >= MAX_PENDING_PER_USER) return { ok: false, message: TOO_MANY_PENDING_MESSAGE };

  const argsEnc = encryptSecret(JSON.stringify(input.args));
  const argsPublic = maskArgsWithSchema(input.tool.paramsSchema, input.args);

  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await db
        .insert(pendingActionsTable)
        .values({
          userId: input.userId,
          // Numero letto e scritto nella stessa istruzione: il massimo dell'utente + 1
          number: sql`(select coalesce(max(${pendingActionsTable.number}), 0) + 1 from ${pendingActionsTable} where ${pendingActionsTable.userId} = ${input.userId})`,
          appId: input.appId,
          toolId: input.tool.id,
          runId: input.runId,
          agentId: input.agentId,
          argsEnc,
          argsPublic,
          recipient: input.recipient,
          summary: input.summary,
        })
        .returning({ number: pendingActionsTable.number });
      return { ok: true, number: row!.number };
    } catch (err) {
      if (attempt < NUMBER_ATTEMPTS && isUniqueViolation(err, NUMBER_CONSTRAINT)) continue;
      throw err;
    }
  }
}
