import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db, appsTable, appArchitectureTable, appArchitectureRunsTable, aiModelsTable } from "@workspace/db";
import {
  GetAppArchitectureParams,
  GetAppArchitectureResponse,
  ListAppArchitectureVersionsParams,
  ListAppArchitectureVersionsResponse,
  GetAppArchitectureVersionParams,
  GetAppArchitectureVersionResponse,
  RefreshAppArchitectureParams,
  RefreshAppArchitectureResponse,
} from "@workspace/api-zod";
import { architectureEligibility, requestArchitectureRefresh } from "../lib/architecture/service";
import { ARCH_MESSAGES } from "../lib/architecture/messages";
import { currentUserId } from "../lib/auth";
import { toNumberOrNull } from "./serializers";
import { consumeArchitectureRefresh } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

/** Quante versioni con testo si elencano. */
const VERSIONS_LISTED = 20;

router.get("/apps/:id/architecture", async (req, res) => {
  const { id } = parseRequest(GetAppArchitectureParams, req.params);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: ARCH_MESSAGES.appNotFound });
    return;
  }
  const [row] = await db.select().from(appArchitectureTable).where(eq(appArchitectureTable.appId, id)).limit(1);
  const elig = await architectureEligibility(app);
  let aiModelName: string | null = null;
  if (row?.aiModelId != null) {
    const [model] = await db
      .select({ name: aiModelsTable.displayName })
      .from(aiModelsTable)
      .where(eq(aiModelsTable.id, row.aiModelId))
      .limit(1);
    aiModelName = model?.name ?? null;
  }
  res.json(
    GetAppArchitectureResponse.parse({
      appId: id,
      refresh: app.architectureRefresh,
      available: elig.ok,
      unavailableReason: elig.ok ? null : elig.reason,
      status: row?.status ?? "idle",
      sha: row?.sha ?? null,
      branch: row?.branch ?? null,
      generatedAt: row?.generatedAt ?? null,
      checkedAt: row?.checkedAt ?? null,
      summary: row?.summary ?? null,
      repoMap: row?.repoMap ?? null,
      lastError: row?.lastError ?? null,
      promptTokens: row?.promptTokens ?? null,
      completionTokens: row?.completionTokens ?? null,
      costUsd: row ? toNumberOrNull(row.costUsd) : null,
      aiModelName,
    }),
  );
});

router.get("/apps/:id/architecture/versions", async (req, res) => {
  const { id } = parseRequest(ListAppArchitectureVersionsParams, req.params);
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: ARCH_MESSAGES.appNotFound });
    return;
  }
  const rows = await db
    .select({
      id: appArchitectureRunsTable.id,
      sha: appArchitectureRunsTable.sha,
      createdAt: appArchitectureRunsTable.createdAt,
      costUsd: appArchitectureRunsTable.costUsd,
    })
    .from(appArchitectureRunsTable)
    .where(and(eq(appArchitectureRunsTable.appId, id), isNotNull(appArchitectureRunsTable.summary)))
    .orderBy(desc(appArchitectureRunsTable.createdAt), desc(appArchitectureRunsTable.id))
    .limit(VERSIONS_LISTED);
  res.json(ListAppArchitectureVersionsResponse.parse(rows.map((r) => ({ ...r, costUsd: toNumberOrNull(r.costUsd) }))));
});

router.get("/apps/:id/architecture/versions/:versionId", async (req, res) => {
  const { id, versionId } = parseRequest(GetAppArchitectureVersionParams, req.params);
  const [row] = await db
    .select()
    .from(appArchitectureRunsTable)
    .where(and(eq(appArchitectureRunsTable.id, versionId), eq(appArchitectureRunsTable.appId, id)))
    .limit(1);
  if (!row || row.summary == null) {
    res.status(404).json({ error: ARCH_MESSAGES.versionNotFound });
    return;
  }
  res.json(
    GetAppArchitectureVersionResponse.parse({
      id: row.id,
      sha: row.sha,
      createdAt: row.createdAt,
      costUsd: toNumberOrNull(row.costUsd),
      summary: row.summary,
    }),
  );
});

router.post("/apps/:id/architecture/refresh", async (req, res) => {
  const { id } = parseRequest(RefreshAppArchitectureParams, req.params);
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: ARCH_MESSAGES.appNotFound });
    return;
  }
  if (!consumeArchitectureRefresh(currentUserId(req))) {
    res.status(429).json({ error: ARCH_MESSAGES.tooMany });
    return;
  }
  const outcome = await requestArchitectureRefresh(id, { bypassOff: true, clearBackoff: true });
  if (outcome === "queued") {
    res.status(202).json(RefreshAppArchitectureResponse.parse({ queued: true }));
    return;
  }
  // `running` ha il suo messaggio fisso; ogni altro esito è il motivo per cui l'App non è idonea
  res.status(409).json({ error: outcome === "running" ? ARCH_MESSAGES.running : outcome });
});

export default router;
