import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  GetAppTestRecipeParams,
  GetAppTestRecipeResponse,
  GetCollaudoSetupResponse,
  GetReleaseTestFileParams,
  GetReleaseTestParams,
  GetReleaseTestResponse,
  ListReleaseTestsQueryParams,
  ListReleaseTestsResponse,
  ListReleaseTestsResponseItem,
  RelightReleaseTestParams,
  SendBackReleaseTestParams,
  UpdateAppTestRecipeBody,
  UpdateAppTestRecipeParams,
  VerifyCollaudoSetupResponse,
} from "@workspace/api-zod";
import {
  db,
  pendingActionsTable,
  releaseTestFilesTable,
  releaseTestStepsTable,
  releaseTestsTable,
  teamWorksTable,
  type ReleaseTestRow,
} from "@workspace/db";
import { currentUserId, sessionOnly } from "../lib/auth";
import { COLLAUDO_MESSAGES, RELEASE_TEST_ROUTE_MESSAGES as MSG } from "../lib/collaudo/messages";
import { validateRecipe } from "../lib/collaudo/recipe";
import { readTestRecipe, saveTestRecipe } from "../lib/collaudo/recipe-store";
import { requestReleaseTest } from "../lib/collaudo/service";
import { collaudoSetup } from "../lib/collaudo/setup";
import { rejectReleaseForTest } from "../lib/teams/release";
import { parseRequest } from "../middlewares/error-handler";
import { consumeTestRelight } from "../middlewares/rate-limit";
import { toNumberOrNull } from "./serializers";

// Collaudo dei lavori prima di «Porta in produzione»: esiti, file, «Riaccendi», «Rimanda alla squadra», ricetta di avvio e
// configurazione. Letture con gli ambiti per metodo; le decisioni e la ricetta non sono dell'agente (AGENT_DENIED_ROUTES).
// Le App sono condivise tra gli utenti ammessi: i collaudi si leggono tutti, la voce «Porta in produzione» è di chi la riceve.

const MAX_LIST = 20;

/** Collaudo senza i segreti (hash di codice e token): il link dal vivo solo finché è valido. */
function publicTest(row: ReleaseTestRow, now: Date = new Date()) {
  const live = row.tunnelUrl !== null && row.tunnelUntil !== null && row.tunnelUntil.getTime() > now.getTime();
  return {
    id: row.id,
    appId: row.appId,
    workId: row.workId,
    instanceId: row.instanceId,
    sha: row.sha,
    mode: row.mode,
    status: row.status,
    outcome: row.outcome,
    report: row.report,
    problems: Array.isArray(row.problems) ? row.problems : null,
    notTestable: Array.isArray(row.notTestable) ? row.notTestable : null,
    error: row.error,
    tunnelUrl: live ? row.tunnelUrl : null,
    tunnelUntil: live ? row.tunnelUntil : null,
    costUsd: toNumberOrNull(row.costUsd),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

async function loadTest(id: number): Promise<ReleaseTestRow | null> {
  const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, id)).limit(1);
  return row ?? null;
}

/** Voce «Porta in produzione» del lavoro del collaudo, se è dell'utente e ancora in attesa. */
async function pendingReleaseItem(test: ReleaseTestRow, userId: number): Promise<{ ok: true; actionId: number } | { ok: false; why: "no_item" | "gone" }> {
  const [work] = await db
    .select({ status: teamWorksTable.status, actionId: teamWorksTable.pendingActionId })
    .from(teamWorksTable)
    .where(eq(teamWorksTable.id, test.workId))
    .limit(1);
  if (!work || work.actionId === null) return { ok: false, why: "gone" };
  const [item] = await db
    .select({ userId: pendingActionsTable.userId, status: pendingActionsTable.status, kind: pendingActionsTable.kind })
    .from(pendingActionsTable)
    .where(eq(pendingActionsTable.id, work.actionId))
    .limit(1);
  // La voce di un altro utente non si vede
  if (!item || item.kind !== "release" || item.userId !== userId) return { ok: false, why: "no_item" };
  if (item.status !== "pending" || work.status !== "awaiting_release") return { ok: false, why: "gone" };
  return { ok: true, actionId: work.actionId };
}

export function createReleaseTestsRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/release-tests", async (req, res) => {
    const { workId, appId } = parseRequest(ListReleaseTestsQueryParams, req.query);
    if (workId === undefined && appId === undefined) {
      res.status(400).json({ error: MSG.needFilter });
      return;
    }
    const conditions = [
      ...(workId !== undefined ? [eq(releaseTestsTable.workId, workId)] : []),
      ...(appId !== undefined ? [eq(releaseTestsTable.appId, appId)] : []),
    ];
    const rows = await db.select().from(releaseTestsTable).where(and(...conditions)).orderBy(desc(releaseTestsTable.id)).limit(MAX_LIST);
    res.json(ListReleaseTestsResponse.parse(rows.map((r) => publicTest(r))));
  });

  router.get("/release-tests/:id", async (req, res) => {
    const { id } = parseRequest(GetReleaseTestParams, req.params);
    const row = await loadTest(id);
    if (!row) {
      res.status(404).json({ error: MSG.testNotFound });
      return;
    }
    const steps = await db.select().from(releaseTestStepsTable).where(eq(releaseTestStepsTable.testId, id)).orderBy(asc(releaseTestStepsTable.position));
    const files = await db
      .select({
        id: releaseTestFilesTable.id,
        kind: releaseTestFilesTable.kind,
        name: releaseTestFilesTable.name,
        contentType: releaseTestFilesTable.contentType,
        size: releaseTestFilesTable.size,
      })
      .from(releaseTestFilesTable)
      .where(eq(releaseTestFilesTable.testId, id))
      .orderBy(asc(releaseTestFilesTable.id));
    res.json(
      GetReleaseTestResponse.parse({
        ...publicTest(row),
        steps: steps.map(({ testId: _testId, ...step }) => step),
        files,
        activity: null,
      }),
    );
  });

  router.get("/release-tests/:id/files/:fileId", async (req, res) => {
    const { id, fileId } = parseRequest(GetReleaseTestFileParams, req.params);
    const [file] = await db
      .select()
      .from(releaseTestFilesTable)
      .where(and(eq(releaseTestFilesTable.id, fileId), eq(releaseTestFilesTable.testId, id)))
      .limit(1);
    if (!file) {
      res.status(404).json({ error: MSG.fileNotFound });
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(file.content);
  });

  router.post("/release-tests/:id/relight", async (req, res) => {
    const { id } = parseRequest(RelightReleaseTestParams, req.params);
    const test = await loadTest(id);
    if (!test) {
      res.status(404).json({ error: MSG.testNotFound });
      return;
    }
    if (test.status !== "done") {
      res.status(409).json({ error: MSG.relightNotDone });
      return;
    }
    const item = await pendingReleaseItem(test, currentUserId(req));
    if (!item.ok && item.why === "no_item") {
      res.status(404).json({ error: MSG.itemNotFound });
      return;
    }
    if (!item.ok) {
      res.status(409).json({ error: MSG.itemNotPending });
      return;
    }
    // Solo l'ultimo collaudo completo del lavoro si riaccende: uno più vecchio è superato da un collaudo nuovo
    const [latest] = await db
      .select({ id: releaseTestsTable.id })
      .from(releaseTestsTable)
      .where(and(eq(releaseTestsTable.workId, test.workId), eq(releaseTestsTable.mode, "full")))
      .orderBy(desc(releaseTestsTable.id))
      .limit(1);
    if (latest?.id !== test.id) {
      res.status(409).json({ error: MSG.relightNotLatest });
      return;
    }
    // Solo le richieste valide consumano il limite
    if (!consumeTestRelight(item.actionId)) {
      res.status(429).json({ error: MSG.relightLimit });
      return;
    }
    const newId = await requestReleaseTest(test.workId, "relight");
    const created = newId === null ? null : await loadTest(newId);
    if (!created) {
      res.status(409).json({ error: MSG.relightFailed });
      return;
    }
    res.status(202).json(ListReleaseTestsResponseItem.parse(publicTest(created)));
  });

  router.post("/release-tests/:id/send-back", sessionOnly, async (req, res) => {
    const { id } = parseRequest(SendBackReleaseTestParams, req.params);
    const test = await loadTest(id);
    if (!test) {
      res.status(404).json({ error: MSG.testNotFound });
      return;
    }
    const item = await pendingReleaseItem(test, currentUserId(req));
    if (!item.ok && item.why === "no_item") {
      res.status(404).json({ error: MSG.itemNotFound });
      return;
    }
    if (!item.ok) {
      res.status(409).json({ error: MSG.sendBackGone });
      return;
    }
    const note = test.report ?? test.error ?? COLLAUDO_MESSAGES.noReport;
    if (!(await rejectReleaseForTest(item.actionId, note, "user"))) {
      res.status(409).json({ error: MSG.sendBackGone });
      return;
    }
    res.status(204).end();
  });

  router.get("/apps/:id/test-recipe", async (req, res) => {
    const { id } = parseRequest(GetAppTestRecipeParams, req.params);
    const view = await readTestRecipe(id);
    if (!view) {
      res.status(404).json({ error: MSG.appNotFound });
      return;
    }
    res.json(GetAppTestRecipeResponse.parse(view));
  });

  router.put("/apps/:id/test-recipe", async (req, res) => {
    const { id } = parseRequest(UpdateAppTestRecipeParams, req.params);
    const body = parseRequest(UpdateAppTestRecipeBody, req.body);
    const checked = validateRecipe(body.recipe);
    if (!checked.ok) {
      res.status(400).json({ error: checked.error });
      return;
    }
    if ((await saveTestRecipe(id, checked.recipe, "user")) === null) {
      res.status(404).json({ error: MSG.appNotFound });
      return;
    }
    res.json(GetAppTestRecipeResponse.parse(await readTestRecipe(id)));
  });

  return router;
}

/** Configurazione del collaudo per Account: solo con il login (con un token personale 403). */
export function createCollaudoSetupRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/", sessionOnly, async (_req, res) => {
    res.json(GetCollaudoSetupResponse.parse(await collaudoSetup()));
  });

  router.post("/verify", sessionOnly, async (_req, res) => {
    res.json(VerifyCollaudoSetupResponse.parse(await collaudoSetup()));
  });

  return router;
}
