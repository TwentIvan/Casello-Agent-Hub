import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, appBootstrapsTable, pendingActionsTable, type AppBootstrap } from "@workspace/db";
import {
  CreateAppBootstrapBody,
  GetAppBootstrapParams,
  GetAppBootstrapResponse,
  GetAppBootstrapConfigResponse,
  GetAppBootstrapForAppParams,
  RetryAppBootstrapParams,
  SetAppBootstrapChecklistItemParams,
  SetAppBootstrapChecklistItemBody,
  CheckAppBootstrapHealthParams,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { parseRequest } from "../middlewares/error-handler";
import { consumeBootstrapHealthCheck } from "../middlewares/rate-limit";
import { createBootstrap, retryBootstrap } from "../lib/app-bootstrap/service";
import { appBaseDomain, appTemplateRepo } from "../lib/app-bootstrap/config";
import { APP_BOOTSTRAP_MESSAGES as M } from "../lib/app-bootstrap/messages";
import { bootstrapNames } from "../lib/app-bootstrap/naming";
import { MANUAL_ITEM_KEYS, buildChecklist } from "../lib/app-bootstrap/checklist";
import { checkHealth } from "../lib/app-bootstrap/health";
import { fetchPage, type WebFetcher } from "../lib/web-reader/fetch-page";

const router: IRouter = Router();

async function view(row: AppBootstrap) {
  let pendingActionNumber: number | null = null;
  if (row.pendingActionId !== null) {
    const [a] = await db.select({ number: pendingActionsTable.number }).from(pendingActionsTable).where(eq(pendingActionsTable.id, row.pendingActionId)).limit(1);
    pendingActionNumber = a?.number ?? null;
  }
  const owner = row.repo.split("/")[0] ?? "";
  return GetAppBootstrapResponse.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    repo: row.repo,
    status: row.status,
    steps: row.steps,
    initCommitSha: row.initCommitSha,
    appId: row.appId,
    analysisId: row.analysisId,
    pendingActionNumber,
    checklist: buildChecklist(row, bootstrapNames(row.slug, owner)),
    healthOkAt: row.healthOkAt,
    healthCheckedAt: row.healthCheckedAt,
    createdAt: row.createdAt,
  });
}

/** La richiesta dell'utente, o null (poi 404 `notFound`). */
async function ownRow(userId: number, id: number): Promise<AppBootstrap | null> {
  const [row] = await db.select().from(appBootstrapsTable).where(and(eq(appBootstrapsTable.id, id), eq(appBootstrapsTable.userId, userId))).limit(1);
  return row ?? null;
}

// Prima di /app-bootstraps/:id, che altrimenti prenderebbe «config» come id
router.get("/app-bootstraps/config", (_req, res) => {
  res.json(GetAppBootstrapConfigResponse.parse({ templateRepo: appTemplateRepo(), baseDomain: appBaseDomain() }));
});

router.post("/app-bootstraps", sessionOnly, async (req, res) => {
  const body = parseRequest(CreateAppBootstrapBody, req.body);
  const out = await createBootstrap(currentUserId(req), body);
  if (!out.ok) {
    res.status(out.status).json({ error: out.message });
    return;
  }
  res.status(201).json({ id: out.id, pendingActionNumber: out.pendingActionNumber });
});

router.get("/app-bootstraps/:id", async (req, res) => {
  const { id } = parseRequest(GetAppBootstrapParams, req.params);
  const row = await ownRow(currentUserId(req), id);
  if (!row) {
    res.status(404).json({ error: M.notFound });
    return;
  }
  res.json(await view(row));
});

router.get("/apps/:id/bootstrap", async (req, res) => {
  const { id } = parseRequest(GetAppBootstrapForAppParams, req.params);
  const [row] = await db
    .select()
    .from(appBootstrapsTable)
    .where(and(eq(appBootstrapsTable.appId, id), eq(appBootstrapsTable.userId, currentUserId(req))))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: M.notFound });
    return;
  }
  res.json(await view(row));
});

router.post("/app-bootstraps/:id/retry", sessionOnly, async (req, res) => {
  const { id } = parseRequest(RetryAppBootstrapParams, req.params);
  const out = await retryBootstrap(currentUserId(req), id);
  if (!out.ok) {
    res.status(out.status).json({ error: out.message });
    return;
  }
  res.status(202).json(await view(out.row));
});

router.put("/app-bootstraps/:id/checklist/:item", async (req, res) => {
  const { id, item } = parseRequest(SetAppBootstrapChecklistItemParams, req.params);
  const { done } = parseRequest(SetAppBootstrapChecklistItemBody, req.body);
  const row = await ownRow(currentUserId(req), id);
  const all = row ? buildChecklist(row, bootstrapNames(row.slug, row.repo.split("/")[0] ?? "")) : [];
  const entry = all.find((i) => i.key === item);
  if (!row || !entry) {
    res.status(404).json({ error: M.notFound });
    return;
  }
  if (entry.auto || !(MANUAL_ITEM_KEYS as readonly string[]).includes(item)) {
    res.status(400).json({ error: M.itemNotManual });
    return;
  }
  const checklist = { ...row.checklist };
  if (done) checklist[item] = { doneAt: checklist[item]?.doneAt ?? new Date().toISOString() };
  else delete checklist[item];
  const [updated] = await db
    .update(appBootstrapsTable)
    .set({ checklist, updatedAt: new Date() })
    .where(eq(appBootstrapsTable.id, id))
    .returning();
  res.json(await view(updated!));
});

router.post("/app-bootstraps/:id/health-check", async (req, res) => {
  const { id } = parseRequest(CheckAppBootstrapHealthParams, req.params);
  const userId = currentUserId(req);
  const row = await ownRow(userId, id);
  if (!row) {
    res.status(404).json({ error: M.notFound });
    return;
  }
  if (!consumeBootstrapHealthCheck(userId)) {
    res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
    return;
  }
  await checkHealth(id, healthFetcher.current);
  res.json(await view((await ownRow(userId, id))!));
});

/** Solo test: sostituisce il fetcher del controllo. */
export const healthFetcher: { current: WebFetcher } = { current: fetchPage };

export default router;
