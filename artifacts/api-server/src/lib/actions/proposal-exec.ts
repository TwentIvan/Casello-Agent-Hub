import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  appToolsTable,
  pendingActionStepsTable,
  pendingActionsTable,
  type PendingActionRow,
  type PendingActionStepRow,
} from "@workspace/db";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { loadAppConnection, toCatalogTool } from "../tools/catalog";
import { executeTool, redactWithJson, truncate } from "../tools/executor";
import type { AppConnection, CatalogTool } from "../tools/types";
import { ACTION_MESSAGES, sensitiveValues, type DecideResult } from "./decide";
import { PROPOSAL_MESSAGES, planExclusion, resolveRefs, stepRefs, type ProposalInput, type StepRef } from "./proposal";
import { proposalEligible } from "./propose";

// Approvazione di una proposta multipla: prenotazione `pending` → `executing` (una volta sola), poi i passi
// da eseguire in ordine, con i riferimenti `{{pN.campo}}` risolti dal risultato JSON completo dei passi
// precedenti. Al primo errore ci si ferma: i passi rimasti diventano `not_run`. Nessun annullamento automatico.

const fail = (status: 400 | 404 | 409 | 500, message: string): DecideResult => ({ ok: false, status, message });

/** Passi delle voci indicate, per voce, in ordine di posizione. */
export async function loadProposalSteps(actionIds: number[]): Promise<Map<number, PendingActionStepRow[]>> {
  const map = new Map<number, PendingActionStepRow[]>();
  if (actionIds.length === 0) return map;
  const rows = await db
    .select()
    .from(pendingActionStepsTable)
    .where(inArray(pendingActionStepsTable.pendingActionId, actionIds))
    .orderBy(asc(pendingActionStepsTable.pendingActionId), asc(pendingActionStepsTable.position));
  for (const row of rows) {
    const list = map.get(row.pendingActionId);
    if (list) list.push(row);
    else map.set(row.pendingActionId, [row]);
  }
  return map;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface PlannedStep {
  row: PendingActionStepRow;
  args: Record<string, unknown>;
  refs: StepRef[];
}

/** Tool del passo riletto dal DB: della stessa app della voce e ancora idoneo, altrimenti null. */
async function loadStepTool(toolId: number, appId: number): Promise<CatalogTool | null> {
  const [row] = await db.select().from(appToolsTable).where(eq(appToolsTable.id, toolId)).limit(1);
  const tool = row ? toCatalogTool(row) : null;
  return tool && tool.appId === appId && proposalEligible(tool) ? tool : null;
}

async function closeStep(id: number, set: { status: "done" | "failed"; result?: string; errorMessage?: string }) {
  await db
    .update(pendingActionStepsTable)
    .set({ ...set, finishedAt: new Date() })
    .where(eq(pendingActionStepsTable.id, id));
}

/** I passi ancora `pending` della voce diventano `not_run`. */
async function markNotRun(actionId: number) {
  await db
    .update(pendingActionStepsTable)
    .set({ status: "not_run" })
    .where(and(eq(pendingActionStepsTable.pendingActionId, actionId), eq(pendingActionStepsTable.status, "pending")));
}

async function finishAction(id: number, set: { status: "done" | "failed"; result?: string; errorMessage?: string }) {
  const [row] = await db
    .update(pendingActionsTable)
    .set({ ...set, finishedAt: new Date() })
    .where(eq(pendingActionsTable.id, id))
    .returning();
  return row ? ({ ok: true, action: row } as const) : fail(404, ACTION_MESSAGES.notFound);
}

export async function approveProposal(userId: number, action: PendingActionRow, exclude: string[]): Promise<DecideResult> {
  const appId = action.appId;
  if (appId === null) return fail(409, ACTION_MESSAGES.notExecutable);

  let proposal: ProposalInput;
  try {
    proposal = JSON.parse(decryptSecret(action.argsEnc)) as ProposalInput;
  } catch (err) {
    logger.error({ actionId: action.id, errName: err instanceof Error ? err.name : "unknown" }, "Proposta in coda non leggibile");
    return fail(500, ACTION_MESSAGES.internal);
  }
  const rows = (await loadProposalSteps([action.id])).get(action.id) ?? [];
  const byKey = new Map(proposal.steps.map((s) => [s.key, s]));
  const planned: PlannedStep[] = [];
  for (const row of rows) {
    const input = byKey.get(row.key);
    const refs = input ? stepRefs(input.args) : null;
    if (!input || !Array.isArray(refs)) return fail(500, ACTION_MESSAGES.internal);
    planned.push({ row, args: input.args, refs });
  }

  // Esclusioni validate prima della prenotazione: un errore lascia la voce `pending`
  const plan = planExclusion(planned.map((p) => ({ key: p.row.key, refs: p.refs })), exclude);
  if (!plan.ok) return fail(400, plan.message);

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(pendingActionsTable)
      .set({ status: "executing", decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(pendingActionsTable.id, action.id), eq(pendingActionsTable.status, "pending")))
      .returning({ id: pendingActionsTable.id });
    if (!row) return false;
    for (const [status, keys] of [
      ["excluded", plan.excluded],
      ["skipped", plan.skipped],
    ] as const) {
      if (keys.size === 0) continue;
      await tx
        .update(pendingActionStepsTable)
        .set({ status })
        .where(and(eq(pendingActionStepsTable.pendingActionId, action.id), inArray(pendingActionStepsTable.key, [...keys])));
    }
    return true;
  });
  if (!claimed) return fail(409, ACTION_MESSAGES.alreadyDecided);

  const toRun = planned.filter((p) => !plan.excluded.has(p.row.key) && !plan.skipped.has(p.row.key));
  const total = toRun.length;
  const results = new Map<string, unknown>();
  let done = 0;
  let current: PlannedStep | null = null;
  // Vero appena parte la chiamata del passo corrente: da lì un errore non prova che l'azione non sia avvenuta
  let called = false;
  let conn: AppConnection | null = null;

  try {
    for (const step of toRun) {
      current = step;
      called = false;
      const tool = await loadStepTool(step.row.toolId, appId);
      if (!tool) {
        await closeStep(step.row.id, { status: "failed", errorMessage: PROPOSAL_MESSAGES.toolUnusable });
        break;
      }
      const resolved = resolveRefs(step.args, results);
      if (!resolved.ok) {
        await closeStep(step.row.id, { status: "failed", errorMessage: PROPOSAL_MESSAGES.unresolved });
        break;
      }
      conn ??= await loadAppConnection(appId);
      called = true;
      // Risposta completa: i riferimenti dei passi successivi si risolvono anche oltre i 20 000 caratteri salvati
      const out = await executeTool({ conn, tool, args: resolved.args, raw: true });
      const saved = truncate(redactWithJson(out.content, sensitiveValues(tool.paramsSchema, resolved.args)));
      if (!out.ok) {
        await closeStep(step.row.id, { status: "failed", errorMessage: saved });
        break;
      }
      const json = parseJson(out.content);
      if (json !== undefined) results.set(step.row.key, json);
      await closeStep(step.row.id, { status: "done", result: saved });
      done += 1;
      current = null;
    }
    await markNotRun(action.id);
    return current === null
      ? await finishAction(action.id, { status: "done", result: `eseguiti ${done} passi su ${total}` })
      : await finishAction(action.id, {
          status: "failed",
          errorMessage: PROPOSAL_MESSAGES.stoppedAt(done, total, current.row.key),
        });
  } catch (err) {
    // Solo il nome dell'errore: il messaggio potrebbe contenere argomenti o credenziali
    logger.error({ actionId: action.id, errName: err instanceof Error ? err.name : "unknown" }, "Esecuzione della proposta non riuscita");
    try {
      const message = called ? ACTION_MESSAGES.uncertain : ACTION_MESSAGES.internal;
      if (current) await closeStep(current.row.id, { status: "failed", errorMessage: message });
      await markNotRun(action.id);
      return await finishAction(action.id, {
        status: "failed",
        errorMessage: current ? PROPOSAL_MESSAGES.stoppedAt(done, total, current.row.key) : message,
      });
    } catch (finishErr) {
      // La voce resta `executing`: all'avvio diventa «incerta» (failInterruptedActions)
      logger.error(
        { actionId: action.id, errName: finishErr instanceof Error ? finishErr.name : "unknown" },
        "Esito della proposta non registrato",
      );
      return fail(500, ACTION_MESSAGES.internalFinish);
    }
  }
}
