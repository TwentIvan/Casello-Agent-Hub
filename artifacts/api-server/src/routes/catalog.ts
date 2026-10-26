import { Router, type IRouter, type RequestHandler } from "express";
import { and, asc, desc, eq, exists, sql } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, catalogRunsTable, modelCatalogTable, type CatalogRun } from "@workspace/db";
import { GetCatalogStatusResponse, ListCatalogModelsQueryParams, ListCatalogModelsResponse, RefreshCatalogResponse } from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { CatalogBusyError, startCatalogRefresh } from "../lib/catalog/refresh";
import type { CatalogSummary } from "../lib/catalog/summary";
import { rateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

// Catalogo dei modelli per provider, ultimo aggiornamento e aggiornamento a richiesta. Il catalogo è
// uguale per tutti; il riepilogo mostra solo gli account dell'utente corrente, mai gli `userId`.

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Esecuzione nella forma pubblica: del riepilogo restano solo gli account di `userId`, senza `userId`. */
function toRunView(run: CatalogRun, userId: number) {
  const summary = run.summary as CatalogSummary | null;
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    summary: summary
      ? {
          ...summary,
          accounts: summary.accounts
            .filter((a) => a.userId === userId)
            .map(({ accountId, accountName, missing }) => ({ accountId, accountName, missing })),
        }
      : null,
  };
}

export function createCatalogRouter(opts: { refreshRateLimit?: RequestHandler; fetchImpl?: typeof fetch } = {}): IRouter {
  const router: IRouter = Router();
  // Ogni aggiornamento scarica due fonti pubbliche e riverifica gli account: 2 al minuto per IP
  const refreshLimit = opts.refreshRateLimit ?? rateLimit({ limit: 2, windowMs: 60_000 });

  router.get("/catalog/models", async (req, res) => {
    const userId = currentUserId(req);
    const { provider } = parseRequest(ListCatalogModelsQueryParams, req.query);
    const mine = exists(
      db
        .select({ one: sql`1` })
        .from(aiModelsTable)
        .innerJoin(aiAccountsTable, eq(aiAccountsTable.id, aiModelsTable.accountId))
        .where(and(eq(aiModelsTable.catalogId, modelCatalogTable.id), eq(aiAccountsTable.userId, userId))),
    );
    const rows = await db
      .select({ row: modelCatalogTable, inMyAccounts: mine })
      .from(modelCatalogTable)
      .where(provider ? eq(modelCatalogTable.provider, provider) : undefined)
      .orderBy(
        asc(modelCatalogTable.provider),
        asc(modelCatalogTable.family),
        sql`${modelCatalogTable.releasedAt} desc nulls last`,
        asc(modelCatalogTable.modelId),
      );
    res.json(
      ListCatalogModelsResponse.parse(
        rows.map(({ row, inMyAccounts }) => ({
          id: row.id,
          provider: row.provider,
          modelId: row.modelId,
          family: row.family,
          version: row.version,
          releasedAt: row.releasedAt,
          priceInput: toNumber(row.priceInputPerMtok),
          priceOutput: toNumber(row.priceOutputPerMtok),
          contextTokens: row.contextTokens,
          supportsTools: row.supportsTools,
          status: row.status,
          deprecationDate: row.deprecationDate,
          inMyAccounts: Boolean(inMyAccounts),
        })),
      ),
    );
  });

  router.get("/catalog/status", async (req, res) => {
    const userId = currentUserId(req);
    const [latest] = await db.select().from(catalogRunsTable).orderBy(desc(catalogRunsTable.startedAt), desc(catalogRunsTable.id)).limit(1);
    const [running] = await db.select({ id: catalogRunsTable.id }).from(catalogRunsTable).where(eq(catalogRunsTable.status, "running")).limit(1);
    res.json(GetCatalogStatusResponse.parse({ running: Boolean(running), latest: latest ? toRunView(latest, userId) : null }));
  });

  router.post("/catalog/refresh", refreshLimit, async (req, res) => {
    const userId = currentUserId(req);
    try {
      const { run } = await startCatalogRefresh({ trigger: "manual", userId, fetchImpl: opts.fetchImpl });
      res.status(202).json(RefreshCatalogResponse.parse(toRunView(run, userId)));
    } catch (err) {
      if (err instanceof CatalogBusyError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
