// Letture della valutazione del modello di un agente (issue #112): ultime run concluse con i conteggi dei passi `tool`,
// modelli degli account dell'utente (candidati) e modelli citati dall'agente e dalle sue run (nomi e prezzi).
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, agentsTable, aiAccountsTable, aiModelsTable, modelOffersTable, runStepsTable, runsTable } from "@workspace/db";
import { NODE_PROVIDER } from "../ai/node-account";
import { effectiveStatus, isPreviewModel, isSelectable } from "../ai/model-status";
import {
  EVALUATION_MAX_RUNS,
  EVALUATION_WINDOW_DAYS,
  evaluateModel,
  type Evaluation,
  type EvaluationModel,
  type EvaluationRun,
} from "./evaluate";

export type AgentModelEvaluation = Evaluation & { agentId: number; agentName: string };

const FINISHED = ["succeeded", "failed", "cancelled"] as const;

const toNumber = (v: string | null): number | null => (v === null ? null : Number(v));

/** Valutazione del modello dell'agente per l'utente (candidati tra i suoi account); null se l'agente non esiste. */
export async function evaluateAgentModel(agentId: number, userId: number, now = new Date()): Promise<AgentModelEvaluation | null> {
  const [agent] = await db
    .select({ id: agentsTable.id, name: agentsTable.name, aiModelId: agentsTable.aiModelId })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);
  if (!agent) return null;

  const since = new Date(now.getTime() - EVALUATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const inWindow = and(eq(runsTable.agentId, agentId), inArray(runsTable.status, [...FINISHED]), gte(runsTable.createdAt, since));
  const [rows, [windowCount]] = await Promise.all([
    db
      .select({
        id: runsTable.id,
        status: runsTable.status,
        aiModelId: runsTable.aiModelId,
        promptTokens: runsTable.promptTokens,
        completionTokens: runsTable.completionTokens,
        cachedTokens: runsTable.cachedTokens,
        costUsd: runsTable.costUsd,
      })
      .from(runsTable)
      .where(inWindow)
      .orderBy(desc(runsTable.createdAt), desc(runsTable.id))
      .limit(EVALUATION_MAX_RUNS),
    db.select({ n: sql<number>`count(*)::int` }).from(runsTable).where(inWindow),
  ]);

  const runIds = rows.map((r) => r.id);
  const steps = runIds.length
    ? await db
        .select({
          runId: runStepsTable.runId,
          calls: sql<number>`count(*)::int`,
          errors: sql<number>`count(*) filter (where ${runStepsTable.ok} = false)::int`,
        })
        .from(runStepsTable)
        .where(and(inArray(runStepsTable.runId, runIds), eq(runStepsTable.type, "tool")))
        .groupBy(runStepsTable.runId)
    : [];
  const stepsByRun = new Map(steps.map((s) => [s.runId, s]));
  const runs: EvaluationRun[] = rows.map((r) => ({
    status: r.status as EvaluationRun["status"],
    aiModelId: r.aiModelId,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    cachedTokens: r.cachedTokens,
    costUsd: toNumber(r.costUsd),
    toolCalls: Number(stepsByRun.get(r.id)?.calls ?? 0),
    toolErrors: Number(stepsByRun.get(r.id)?.errors ?? 0),
  }));

  // Modelli dell'utente (candidati) più quelli dell'agente e delle run, anche di altri account (solo nome e prezzi)
  const cited = [...new Set([agent.aiModelId, ...runs.map((r) => r.aiModelId)].filter((id): id is number => id !== null))];
  const modelRows = await db
    .select({ model: aiModelsTable, account: aiAccountsTable, offer: modelOffersTable })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .leftJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
    .where(
      cited.length
        ? or(and(eq(aiAccountsTable.userId, userId), eq(aiModelsTable.hidden, false)), inArray(aiModelsTable.id, cited))
        : and(eq(aiAccountsTable.userId, userId), eq(aiModelsTable.hidden, false)),
    );
  const models: EvaluationModel[] = modelRows.map(({ model, account, offer }) => {
    const status = effectiveStatus(
      { availability: model.availability, catalogStatus: offer?.status ?? null, deprecationDate: offer?.deprecationDate ?? null },
      now,
    );
    const supportsTools = offer ? offer.supportsTools : model.supportsTools;
    return {
      id: model.id,
      name: model.displayName,
      accountName: account.name,
      priceInput: toNumber(model.priceInputPerMtok),
      priceOutput: toNumber(model.priceOutputPerMtok),
      priceCachedInput: toNumber(model.priceCachedInputPerMtok),
      eligible:
        account.userId === userId &&
        !model.hidden &&
        account.provider !== NODE_PROVIDER &&
        supportsTools === true &&
        !isPreviewModel(model.modelId) &&
        isSelectable(status, supportsTools, model.modelId),
    };
  });

  const evaluation = evaluateModel({
    currentModelId: agent.aiModelId,
    runs,
    runsInWindow: Number(windowCount?.n ?? 0),
    models,
  });
  return { agentId: agent.id, agentName: agent.name, ...evaluation };
}
