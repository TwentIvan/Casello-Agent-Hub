import { Router, type IRouter, type RequestHandler } from "express";
import { and, asc, count, desc, eq, exists, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  aiAccountsTable,
  aiModelsTable,
  catalogRunsTable,
  modelOffersTable,
  modelsTable,
  providersTable,
  type CatalogRun,
} from "@workspace/db";
import {
  GetCatalogStatusResponse,
  GetProviderIssueParams,
  GetProviderIssueResponse,
  ListCatalogModelOffersParams,
  ListCatalogModelOffersResponse,
  ListCatalogModelsQueryParams,
  ListCatalogModelsResponse,
  ListCatalogProvidersQueryParams,
  ListCatalogProvidersResponse,
  RefreshCatalogResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { providerIssue } from "../lib/catalog/provider-issue";
import { CatalogBusyError, startCatalogRefresh } from "../lib/catalog/refresh";
import type { OfferSummary } from "../lib/catalog/summary";
import { rateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

// Catalogo universale (modelli, offerte, provider), ultimo aggiornamento e aggiornamento a richiesta. Il
// catalogo è uguale per tutti; "nei miei account", "utilizzabile" e il riepilogo guardano solo gli account
// dell'utente corrente, mai gli `userId`. Le liste lunghe si filtrano e si paginano in SQL.

const ISSUE_EXAMPLES = 5;

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Testo cercato con ILIKE … ESCAPE '\': `%`, `_` e la barra rovesciata restano letterali. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Booleano in query: solo `true`/`false` (la coercizione generata renderebbe vero qualsiasi testo, anche "false"). */
const queryBoolean = z.enum(["true", "false"]).transform((v) => v === "true").optional();

/** Query dell'elenco dei modelli: booleani stretti, pagine e contesto interi. */
const ListModelsQuery = ListCatalogModelsQueryParams.extend({
  tools: queryBoolean,
  vision: queryBoolean,
  reasoning: queryBoolean,
  usable: queryBoolean,
  includeRetired: queryBoolean,
}).superRefine((v, ctx) => {
  for (const k of ["page", "pageSize", "minContext"] as const) {
    const n = v[k];
    if (n !== undefined && !Number.isInteger(n)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "atteso un intero" });
  }
});

/** Un solo `author`/`provider` arriva come testo: diventa una lista. */
function parseListQuery(query: Record<string, unknown>) {
  const raw: Record<string, unknown> = { ...query };
  for (const k of ["author", "provider"]) if (typeof raw[k] === "string") raw[k] = [raw[k]];
  return parseRequest(ListModelsQuery, raw);
}

type ListQuery = ReturnType<typeof parseListQuery>;

interface ModelPageRow extends Record<string, unknown> {
  id: number;
  canonical_key: string;
  author: string;
  family: string;
  version: string;
  mode: string;
  supports_tools: boolean | null;
  supports_vision: boolean | null;
  supports_reasoning: boolean | null;
  released_at: Date | string | null;
  offer_count: number;
  cheap_provider: string | null;
  cheap_input: string | null;
  cheap_output: string | null;
  in_my_accounts: boolean;
}

/**
 * Elenco dei modelli in SQL: `o` sono le offerte visibili (senza le ritirate salvo `includeRetired`), `agg`
 * il loro numero e il contesto massimo per modello, `cheap` l'offerta più economica con entrambi i prezzi
 * (parità: slug del provider, poi id presso il provider). Un modello senza offerte visibili non compare.
 * Restituisce la query della pagina e quella del totale con gli stessi filtri.
 */
function modelListQueries(f: ListQuery, userId: number): { page: SQL; total: SQL } {
  const visible = f.includeRetired ? sql`true` : sql`status <> 'retired'`;
  const ctes = sql`
    WITH o AS (SELECT * FROM model_offers WHERE ${visible}),
    agg AS (SELECT model_id, count(*)::int AS offer_count, max(context_tokens) AS max_context FROM o GROUP BY model_id),
    cheap AS (
      SELECT DISTINCT ON (model_id) model_id, provider, price_input_per_mtok, price_output_per_mtok,
             price_input_per_mtok + price_output_per_mtok AS total
      FROM o
      WHERE price_input_per_mtok IS NOT NULL AND price_output_per_mtok IS NOT NULL
      ORDER BY model_id, price_input_per_mtok + price_output_per_mtok, provider, provider_model_id
    )`;

  const where: SQL[] = [];
  if (f.mode !== "all") where.push(sql`m.mode = ${f.mode}`);
  if (f.q !== undefined && f.q.trim() !== "") {
    const p = likePattern(f.q.trim());
    where.push(sql`(m.canonical_key ILIKE ${p} ESCAPE '\\' OR m.family ILIKE ${p} ESCAPE '\\' OR m.version ILIKE ${p} ESCAPE '\\'
      OR m.author ILIKE ${p} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM o WHERE o.model_id = m.id AND o.provider_model_id ILIKE ${p} ESCAPE '\\'))`);
  }
  const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  if (f.author?.length) where.push(sql`m.author IN (${list(f.author)})`);
  if (f.provider?.length) where.push(sql`EXISTS (SELECT 1 FROM o WHERE o.model_id = m.id AND o.provider IN (${list(f.provider)}))`);
  if (f.tools !== undefined) where.push(sql`m.supports_tools = ${f.tools}`);
  if (f.vision !== undefined) where.push(sql`m.supports_vision = ${f.vision}`);
  if (f.reasoning !== undefined) where.push(sql`m.supports_reasoning = ${f.reasoning}`);
  if (f.usable) {
    // Provider di un account dell'utente (l'account di sistema non ha utente), gestito o no
    where.push(sql`EXISTS (SELECT 1 FROM o JOIN ai_accounts a ON a.provider = o.provider WHERE o.model_id = m.id AND a.user_id = ${userId})`);
  }
  if (f.maxPrice !== undefined) where.push(sql`cheap.total <= ${f.maxPrice}`);
  if (f.minContext !== undefined) where.push(sql`agg.max_context >= ${f.minContext}`);
  const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql.empty();
  const from = sql`FROM models m JOIN agg ON agg.model_id = m.id LEFT JOIN cheap ON cheap.model_id = m.id`;

  const byName = sql`lower(m.family), lower(m.version), m.canonical_key, m.id`;
  const order = {
    name: byName,
    price: sql`cheap.total ASC NULLS LAST, ${byName}`,
    released: sql`m.released_at DESC NULLS LAST, ${byName}`,
    context: sql`agg.max_context DESC NULLS LAST, ${byName}`,
  }[f.sort];

  const page = sql`${ctes}
    SELECT m.id, m.canonical_key, m.author, m.family, m.version, m.mode, m.supports_tools, m.supports_vision,
           m.supports_reasoning, m.released_at AT TIME ZONE 'UTC' AS released_at, agg.offer_count,
           cheap.provider AS cheap_provider, cheap.price_input_per_mtok AS cheap_input,
           cheap.price_output_per_mtok AS cheap_output,
           EXISTS (
             SELECT 1 FROM model_offers mo
             JOIN ai_models am ON am.offer_id = mo.id
             JOIN ai_accounts a ON a.id = am.account_id
             WHERE mo.model_id = m.id AND a.user_id = ${userId}
           ) AS in_my_accounts
    ${from} ${whereSql}
    ORDER BY ${order}
    LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
  const total = sql`${ctes} SELECT count(*)::int AS total ${from} ${whereSql}`;
  return { page, total };
}

function toModelSummary(r: ModelPageRow) {
  const cheapInput = toNumber(r.cheap_input);
  const cheapOutput = toNumber(r.cheap_output);
  return {
    id: r.id,
    canonicalKey: r.canonical_key,
    author: r.author,
    family: r.family,
    version: r.version,
    mode: r.mode,
    supportsTools: r.supports_tools,
    supportsVision: r.supports_vision,
    supportsReasoning: r.supports_reasoning,
    releasedAt: r.released_at === null ? null : new Date(r.released_at),
    offerCount: r.offer_count,
    cheapestOffer:
      r.cheap_provider !== null && cheapInput !== null && cheapOutput !== null
        ? { provider: r.cheap_provider, priceInput: cheapInput, priceOutput: cheapOutput }
        : null,
    inMyAccounts: r.in_my_accounts,
  };
}

/** Un modello di un account dell'utente è collegato all'offerta `offerId` (colonna o espressione SQL). */
function linkedToMyAccounts(offerId: SQL | typeof modelOffersTable.id, userId: number) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(aiModelsTable)
      .innerJoin(aiAccountsTable, eq(aiAccountsTable.id, aiModelsTable.accountId))
      .where(and(eq(aiModelsTable.offerId, offerId), eq(aiAccountsTable.userId, userId))),
  );
}

/** Esecuzione nella forma pubblica: del riepilogo restano solo gli account di `userId`, senza `userId`. */
function toRunView(run: CatalogRun, userId: number) {
  const summary = run.summary as OfferSummary | null;
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
          // I riepiloghi precedenti ai provider scoperti non hanno il campo
          newProviders: summary.newProviders ?? [],
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
    const filters = parseListQuery(req.query as Record<string, unknown>);
    const { page, total } = modelListQueries(filters, userId);
    const [rows, totals] = await Promise.all([db.execute<ModelPageRow>(page), db.execute<{ total: number }>(total)]);
    res.json(
      ListCatalogModelsResponse.parse({
        items: rows.rows.map(toModelSummary),
        total: totals.rows[0]?.total ?? 0,
        page: filters.page,
        pageSize: filters.pageSize,
      }),
    );
  });

  router.get("/catalog/models/:id/offers", async (req, res) => {
    const userId = currentUserId(req);
    const { id } = parseRequest(ListCatalogModelOffersParams, req.params);
    const [model] = await db.select({ id: modelsTable.id }).from(modelsTable).where(eq(modelsTable.id, id)).limit(1);
    if (!model) {
      res.status(404).json({ error: "Modello non trovato" });
      return;
    }
    const rows = await db
      .select({
        offer: modelOffersTable,
        providerName: providersTable.name,
        providerStatus: providersTable.status,
        inMyAccounts: linkedToMyAccounts(modelOffersTable.id, userId),
      })
      .from(modelOffersTable)
      .innerJoin(providersTable, eq(providersTable.slug, modelOffersTable.provider))
      .where(eq(modelOffersTable.modelId, id))
      .orderBy(
        sql`${modelOffersTable.priceInputPerMtok} + ${modelOffersTable.priceOutputPerMtok} ASC NULLS LAST`,
        asc(modelOffersTable.provider),
        asc(modelOffersTable.providerModelId),
      );
    res.json(
      ListCatalogModelOffersResponse.parse(
        rows.map(({ offer, providerName, providerStatus, inMyAccounts }) => ({
          id: offer.id,
          provider: offer.provider,
          providerName,
          providerStatus,
          providerModelId: offer.providerModelId,
          priceInput: toNumber(offer.priceInputPerMtok),
          priceOutput: toNumber(offer.priceOutputPerMtok),
          contextTokens: offer.contextTokens,
          supportsTools: offer.supportsTools,
          status: offer.status,
          deprecationDate: offer.deprecationDate,
          inMyAccounts: Boolean(inMyAccounts),
        })),
      ),
    );
  });

  router.get("/catalog/providers", async (req, res) => {
    const userId = currentUserId(req);
    const { q, status } = parseRequest(ListCatalogProvidersQueryParams, req.query);
    const where: SQL[] = [ne(providersTable.slug, "system_gateway")];
    if (status) where.push(eq(providersTable.status, status));
    if (q !== undefined && q.trim() !== "") {
      const p = likePattern(q.trim());
      where.push(or(sql`${providersTable.slug} ILIKE ${p} ESCAPE '\\'`, sql`${providersTable.name} ILIKE ${p} ESCAPE '\\'`)!);
    }
    const rows = await db
      .select({
        provider: providersTable,
        modelCount: sql<number>`(
          SELECT count(DISTINCT mo.model_id)::int FROM ${modelOffersTable} mo
          WHERE mo.provider = ${providersTable.slug} AND mo.status <> 'retired'
        )`,
        hasMyAccount: exists(
          db
            .select({ one: sql`1` })
            .from(aiAccountsTable)
            .where(and(eq(aiAccountsTable.provider, providersTable.slug), eq(aiAccountsTable.userId, userId))),
        ),
      })
      .from(providersTable)
      .where(and(...where))
      // L'enum provider_status è ordinato: gestiti, in arrivo, non gestiti
      .orderBy(asc(providersTable.status), asc(providersTable.name), asc(providersTable.slug));
    res.json(
      ListCatalogProvidersResponse.parse(
        rows.map(({ provider: p, modelCount, hasMyAccount }) => ({
          slug: p.slug,
          name: p.name,
          protocol: p.protocol,
          status: p.status,
          origin: p.origin,
          firstSeenAt: p.firstSeenAt,
          modelCount: Number(modelCount),
          hasMyAccount: Boolean(hasMyAccount),
        })),
      ),
    );
  });

  router.get("/catalog/providers/:slug/issue", async (req, res) => {
    const { slug } = parseRequest(GetProviderIssueParams, req.params);
    const [provider] = await db.select().from(providersTable).where(eq(providersTable.slug, slug)).limit(1);
    if (!provider || provider.status !== "unmanaged") {
      res.status(404).json({ error: "Provider non gestito non trovato" });
      return;
    }
    const [counted] = await db.select({ n: count() }).from(modelOffersTable).where(eq(modelOffersTable.provider, slug));
    const examples = await db
      .select({ id: modelOffersTable.providerModelId })
      .from(modelOffersTable)
      .where(eq(modelOffersTable.provider, slug))
      .orderBy(asc(modelOffersTable.providerModelId))
      .limit(ISSUE_EXAMPLES);
    res.json(GetProviderIssueResponse.parse(providerIssue(provider, counted?.n ?? 0, examples.map((e) => e.id))));
  });

  router.get("/catalog/status", async (req, res) => {
    const userId = currentUserId(req);
    const [latest] = await db.select().from(catalogRunsTable).orderBy(desc(catalogRunsTable.startedAt), desc(catalogRunsTable.id)).limit(1);
    const [running] = await db.select({ id: catalogRunsTable.id }).from(catalogRunsTable).where(eq(catalogRunsTable.status, "running")).limit(1);
    // Le novità vengono dall'ultima esecuzione riuscita, anche mentre ne gira o ne è fallita un'altra
    const [lastCompleted] = await db
      .select()
      .from(catalogRunsTable)
      .where(inArray(catalogRunsTable.status, ["completed", "partial"]))
      .orderBy(desc(catalogRunsTable.startedAt), desc(catalogRunsTable.id))
      .limit(1);
    res.json(
      GetCatalogStatusResponse.parse({
        running: Boolean(running),
        latest: latest ? toRunView(latest, userId) : null,
        lastCompleted: lastCompleted ? toRunView(lastCompleted, userId) : null,
      }),
    );
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
