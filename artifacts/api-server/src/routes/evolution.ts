import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, aiModelsTable, appsTable, usersTable, type EvolutionCycle, type EvolutionRound } from "@workspace/db";
import {
  GetAppEvolutionParams,
  GetAppEvolutionResponse,
  SaveAppEvolutionParams,
  SaveAppEvolutionBody,
  SaveAppEvolutionResponse,
  DeleteAppEvolutionParams,
  GetAppEvolutionConsentTextParams,
  GetAppEvolutionConsentTextQueryParams,
  GetAppEvolutionConsentTextResponse,
  StopAppEvolutionParams,
  StopAppEvolutionResponse,
  ResumeAppEvolutionParams,
  ResumeAppEvolutionResponse,
  RunAppEvolutionNowParams,
  RunAppEvolutionNowResponse,
  ListAppEvolutionRoundsParams,
  ListAppEvolutionRoundsResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { CONSENT_VERSION, consentText } from "../lib/evolution/consent";
import { EVOLUTION_MESSAGES } from "../lib/evolution/messages";
import {
  EvolutionError,
  consentValid,
  deleteCycle,
  getCycle,
  listRounds,
  resumeCycle,
  saveCycle,
  startRound,
  stopCycle,
} from "../lib/evolution/service";
import { cycleSpend } from "../lib/evolution/spend";
import { consumeEvolutionRunNow } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

// Giri aperti: se ne mostra uno nella vista del ciclo
const OPEN_STATUSES = new Set(["analyzing", "approving", "implementing", "awaiting_release"]);

function roundView(r: EvolutionRound) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    analysisId: r.analysisId,
    itemIds: r.itemIds,
    outcome: r.outcome,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

async function cycleView(cycle: EvolutionCycle, userId: number) {
  const [model] =
    cycle.analysisAiModelId === null
      ? []
      : await db.select({ name: aiModelsTable.displayName }).from(aiModelsTable).where(eq(aiModelsTable.id, cycle.analysisAiModelId)).limit(1);
  const [payer] =
    cycle.activatedBy === null
      ? []
      : await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, cycle.activatedBy)).limit(1);
  const spend = await cycleSpend(cycle.appId);
  const rounds = await listRounds(cycle.appId);
  const open = rounds.find((r) => OPEN_STATUSES.has(r.status));
  return {
    appId: cycle.appId,
    status: cycle.status,
    pausedReason: cycle.pausedReason,
    frequency: cycle.frequency,
    itemsPerRound: cycle.itemsPerRound,
    analysisAiModelId: cycle.analysisAiModelId,
    analysisModelName: model?.name ?? null,
    teamTemplateId: cycle.teamTemplateId,
    mergeMode: cycle.mergeMode,
    stagingBranch: cycle.stagingBranch,
    stagingUrl: cycle.stagingUrl,
    monthlyBudgetUsd: Number(cycle.monthlyBudgetUsd),
    spentUsd: spend.spentUsd,
    unpricedCount: spend.unpricedCount,
    activatedByName: payer?.name ?? null,
    isPayer: cycle.activatedBy !== null && cycle.activatedBy === userId,
    consentAt: cycle.consentAt,
    consentValid: consentValid(cycle),
    nextRoundAt: cycle.nextRoundAt,
    lastError: cycle.lastError,
    openRound: open ? roundView(open) : null,
  };
}

async function requireApp(id: number) {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id)).limit(1);
  return app ?? null;
}

router.get("/apps/:id/evolution", async (req, res) => {
  const { id } = parseRequest(GetAppEvolutionParams, req.params);
  if (!(await requireApp(id))) {
    res.status(404).json({ error: EVOLUTION_MESSAGES.appNotFound });
    return;
  }
  const cycle = await getCycle(id);
  res.json(GetAppEvolutionResponse.parse(cycle ? await cycleView(cycle, currentUserId(req)) : null));
});

router.get("/apps/:id/evolution/consent-text", async (req, res) => {
  const { id } = parseRequest(GetAppEvolutionConsentTextParams, req.params);
  const query = parseRequest(GetAppEvolutionConsentTextQueryParams, req.query);
  const app = await requireApp(id);
  if (!app) {
    res.status(404).json({ error: EVOLUTION_MESSAGES.appNotFound });
    return;
  }
  const lines = consentText({
    mergeMode: query.mergeMode,
    stagingBranch: query.stagingBranch ?? null,
    teamTemplateId: query.teamTemplateId ?? null,
    analysisAiModelId: query.analysisAiModelId,
    itemsPerRound: query.itemsPerRound,
    monthlyBudgetUsd: query.monthlyBudgetUsd,
    appName: app.name,
    // Senza chiamare GitHub: il predefinito del repository si conosce solo con una richiesta
    baseBranch: app.sourceBranch ?? "main",
  });
  res.json(GetAppEvolutionConsentTextResponse.parse({ version: CONSENT_VERSION, lines }));
});

/** Errori di regola del servizio: stato e messaggio fisso. */
function handleEvolutionError(err: unknown, res: import("express").Response): boolean {
  if (err instanceof EvolutionError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

router.put("/apps/:id/evolution", sessionOnly, async (req, res) => {
  const { id } = parseRequest(SaveAppEvolutionParams, req.params);
  const body = parseRequest(SaveAppEvolutionBody, req.body);
  try {
    const cycle = await saveCycle(id, currentUserId(req), {
      ...body,
      consent: body.consent === undefined ? undefined : { ...body.consent, accepted: body.consent.accepted as true },
    });
    res.json(SaveAppEvolutionResponse.parse(await cycleView(cycle, currentUserId(req))));
  } catch (err) {
    if (!handleEvolutionError(err, res)) throw err;
  }
});

router.delete("/apps/:id/evolution", sessionOnly, async (req, res) => {
  const { id } = parseRequest(DeleteAppEvolutionParams, req.params);
  try {
    await deleteCycle(id);
    res.status(204).end();
  } catch (err) {
    if (!handleEvolutionError(err, res)) throw err;
  }
});

router.post("/apps/:id/evolution/stop", sessionOnly, async (req, res) => {
  const { id } = parseRequest(StopAppEvolutionParams, req.params);
  try {
    res.json(StopAppEvolutionResponse.parse(await cycleView(await stopCycle(id), currentUserId(req))));
  } catch (err) {
    if (!handleEvolutionError(err, res)) throw err;
  }
});

router.post("/apps/:id/evolution/resume", sessionOnly, async (req, res) => {
  const { id } = parseRequest(ResumeAppEvolutionParams, req.params);
  try {
    res.json(ResumeAppEvolutionResponse.parse(await cycleView(await resumeCycle(id, currentUserId(req)), currentUserId(req))));
  } catch (err) {
    if (!handleEvolutionError(err, res)) throw err;
  }
});

router.post("/apps/:id/evolution/run-now", sessionOnly, async (req, res) => {
  const { id } = parseRequest(RunAppEvolutionNowParams, req.params);
  const cycle = await getCycle(id);
  if (!cycle) {
    res.status(404).json({ error: EVOLUTION_MESSAGES.notFound });
    return;
  }
  // Come «Riprendi»: avvia un giro solo chi paga (chi ha attivato il ciclo)
  if (cycle.activatedBy !== currentUserId(req)) {
    res.status(403).json({ error: EVOLUTION_MESSAGES.notPayer });
    return;
  }
  if (!consumeEvolutionRunNow(id)) {
    res.status(429).json({ error: EVOLUTION_MESSAGES.tooManyRuns });
    return;
  }
  try {
    const round = await startRound(cycle.id, { manual: true });
    res.status(202).json(RunAppEvolutionNowResponse.parse(roundView(round)));
  } catch (err) {
    if (!handleEvolutionError(err, res)) throw err;
  }
});

router.get("/apps/:id/evolution/rounds", async (req, res) => {
  const { id } = parseRequest(ListAppEvolutionRoundsParams, req.params);
  if (!(await requireApp(id))) {
    res.status(404).json({ error: EVOLUTION_MESSAGES.appNotFound });
    return;
  }
  res.json(ListAppEvolutionRoundsResponse.parse((await listRounds(id)).map(roundView)));
});

export default router;
