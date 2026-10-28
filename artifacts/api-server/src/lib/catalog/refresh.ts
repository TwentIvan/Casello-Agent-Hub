import { and, asc, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
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
import { logger } from "../logger";
import { isUniqueViolation } from "../pg-errors";
import { enrichFromCatalog, verifyAccount, type Tx } from "../ai/accounts";
import { fetchLiteLlmSource, fetchOpenRouterSource, SourceError, type SourceEntry, type SourceName } from "./sources";
import { keepFailedOfferFields, mergeUniversal, type DiscoveredProvider, type ModelRecord, type OfferRecord } from "./merge";
import { ensureProviderRegistry } from "./provider-registry";
import { PROVIDER_REGISTRY } from "./provider-registry-data";
import { summarizeOffers, type OfferSummary } from "./summary";

// Aggiornamento del catalogo: scarica le fonti, aggiorna `models`, `model_offers` e i provider scoperti,
// riverifica gli account degli utenti, arricchisce i loro modelli e registra il riepilogo in `catalog_runs`.
// Una sola esecuzione alla volta (indice unico parziale sulla riga `running`). Errori sempre a testo fisso:
// mai chiavi, URL o messaggi grezzi di fonti e provider.

const KEEP_RUNS = 20;
const CHUNK = 500;
const UNEXPECTED_ERROR = "aggiornamento non riuscito";
const INTERRUPTED_ERROR = "interrotto dal riavvio";

export class CatalogBusyError extends Error {
  constructor() {
    super("aggiornamento già in corso");
    this.name = "CatalogBusyError";
  }
}

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toPrice(v: number | null): string | null {
  return v === null ? null : String(v);
}

/** Offerte del DB nella forma della fusione, per l'aggiornamento parziale e il riepilogo. */
async function loadOffers(): Promise<OfferRecord[]> {
  const rows = await db
    .select({ offer: modelOffersTable, canonicalKey: modelsTable.canonicalKey })
    .from(modelOffersTable)
    .innerJoin(modelsTable, eq(modelOffersTable.modelId, modelsTable.id));
  return rows.map(({ offer: r, canonicalKey }) => ({
    provider: r.provider,
    providerModelId: r.providerModelId,
    canonicalKey,
    priceInput: toNumber(r.priceInputPerMtok),
    priceOutput: toNumber(r.priceOutputPerMtok),
    priceCachedInput: toNumber(r.priceCachedInputPerMtok),
    contextTokens: r.contextTokens,
    supportsTools: r.supportsTools,
    status: r.status,
    deprecationDate: r.deprecationDate,
    sources: r.sources as OfferRecord["sources"],
  }));
}

/** Crea i provider scoperti che mancano; quelli esistenti (del registro o già scoperti) non si toccano. */
async function insertDiscovered(tx: Tx, discovered: DiscoveredProvider[], now: Date): Promise<DiscoveredProvider[]> {
  if (!discovered.length) return [];
  const created = await tx
    .insert(providersTable)
    .values(
      discovered.map((d) => ({
        slug: d.slug,
        name: d.name || d.slug,
        protocol: "unknown" as const,
        defaultBaseUrl: null,
        sourceKeys: { litellm: d.name ? [d.name] : [], openrouterAuthor: null },
        status: "unmanaged" as const,
        origin: "discovered" as const,
        firstSeenAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({ target: providersTable.slug })
    .returning({ slug: providersTable.slug });
  const slugs = new Set(created.map((c) => c.slug));
  return discovered.filter((d) => slugs.has(d.slug));
}

/**
 * Inserisce o aggiorna i modelli. In un aggiornamento parziale i modelli già presenti non cambiano: i loro
 * campi (tipo, capacità, versione, rilascio) dipendono anche dalla fonte caduta.
 */
async function upsertModels(tx: Tx, models: ModelRecord[], partial: boolean, now: Date): Promise<void> {
  for (let i = 0; i < models.length; i += CHUNK) {
    const insert = tx.insert(modelsTable).values(
      models.slice(i, i + CHUNK).map((m) => ({
        canonicalKey: m.canonicalKey,
        author: m.author,
        family: m.family,
        version: m.version,
        mode: m.mode,
        supportsTools: m.supportsTools,
        supportsVision: m.supportsVision,
        supportsReasoning: m.supportsReasoning,
        releasedAt: m.releasedAt,
        updatedAt: now,
      })),
    );
    if (partial) {
      await insert.onConflictDoNothing({ target: modelsTable.canonicalKey });
      continue;
    }
    await insert.onConflictDoUpdate({
      target: modelsTable.canonicalKey,
      set: {
        author: sql`excluded.author`,
        family: sql`excluded.family`,
        version: sql`excluded.version`,
        mode: sql`excluded.mode`,
        supportsTools: sql`excluded.supports_tools`,
        supportsVision: sql`excluded.supports_vision`,
        supportsReasoning: sql`excluded.supports_reasoning`,
        releasedAt: sql`excluded.released_at`,
        updatedAt: now,
      },
    });
  }
}

/** Inserisce o aggiorna le offerte delle fonti; quelle assenti dalle fonti restano come sono. */
async function upsertOffers(tx: Tx, offers: OfferRecord[], modelIds: Map<string, number>, now: Date): Promise<void> {
  for (let i = 0; i < offers.length; i += CHUNK) {
    await tx
      .insert(modelOffersTable)
      .values(
        offers.slice(i, i + CHUNK).map((o) => ({
          modelId: modelIds.get(o.canonicalKey)!,
          provider: o.provider,
          providerModelId: o.providerModelId,
          priceInputPerMtok: toPrice(o.priceInput),
          priceOutputPerMtok: toPrice(o.priceOutput),
          priceCachedInputPerMtok: toPrice(o.priceCachedInput),
          contextTokens: o.contextTokens,
          supportsTools: o.supportsTools,
          status: o.status,
          deprecationDate: o.deprecationDate,
          sources: o.sources,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [modelOffersTable.provider, modelOffersTable.providerModelId],
        set: {
          modelId: sql`excluded.model_id`,
          priceInputPerMtok: sql`excluded.price_input_per_mtok`,
          priceOutputPerMtok: sql`excluded.price_output_per_mtok`,
          priceCachedInputPerMtok: sql`excluded.price_cached_input_per_mtok`,
          contextTokens: sql`excluded.context_tokens`,
          supportsTools: sql`excluded.supports_tools`,
          status: sql`excluded.status`,
          deprecationDate: sql`excluded.deprecation_date`,
          sources: sql`excluded.sources`,
          updatedAt: now,
        },
      });
  }
}

/**
 * Scrive in una transazione provider scoperti, modelli e offerte. Restituisce i provider creati e la versione
 * leggibile di ogni modello (per chiave canonica), per il riepilogo.
 */
async function writeCatalog(
  merged: { models: ModelRecord[]; offers: OfferRecord[]; discovered: DiscoveredProvider[] },
  partial: boolean,
  now: Date,
): Promise<{ newProviders: DiscoveredProvider[]; versions: Map<string, string> }> {
  // I provider del registro servono alla chiave esterna delle offerte (di solito già allineati all'avvio)
  await ensureProviderRegistry(PROVIDER_REGISTRY);
  return db.transaction(async (tx) => {
    const newProviders = await insertDiscovered(tx, merged.discovered, now);
    await upsertModels(tx, merged.models, partial, now);
    const rows = await tx.select({ id: modelsTable.id, canonicalKey: modelsTable.canonicalKey, version: modelsTable.version }).from(modelsTable);
    await upsertOffers(tx, merged.offers, new Map(rows.map((r) => [r.canonicalKey, r.id])), now);
    return { newProviders, versions: new Map(rows.map((r) => [r.canonicalKey, r.version])) };
  });
}

/**
 * Rilegge `/models` di ogni account degli utenti (non quello di sistema), uno alla volta: un errore non
 * ferma gli altri. Riporta i modelli scoperti prima e non più elencati, solo per le verifiche riuscite
 * con un elenco non vuoto.
 */
async function reverifyAccounts(): Promise<OfferSummary["accounts"]> {
  const accounts = await db.select().from(aiAccountsTable).where(isNotNull(aiAccountsTable.userId)).orderBy(asc(aiAccountsTable.id));
  const out: OfferSummary["accounts"] = [];
  for (const account of accounts) {
    try {
      const before = await db
        .select({ modelId: aiModelsTable.modelId })
        .from(aiModelsTable)
        .where(and(eq(aiModelsTable.accountId, account.id), eq(aiModelsTable.discovered, true)))
        .orderBy(asc(aiModelsTable.modelId));
      const models = await verifyAccount(account);
      // Errore o elenco vuoto (provider senza `/models`): l'elenco è ignoto, non "tutto sparito"
      if (models === null || models.length === 0) continue;
      const listed = new Set(models.map((m) => m.modelId));
      const missing = before.map((m) => m.modelId).filter((id) => !listed.has(id));
      if (missing.length) out.push({ accountId: account.id, userId: account.userId!, accountName: account.name, missing });
    } catch (err) {
      logger.warn(
        { accountId: account.id, errName: err instanceof Error ? err.name : "unknown" },
        "Verifica di un account durante l'aggiornamento del catalogo non riuscita",
      );
    }
  }
  return out;
}

async function finishRun(id: number, set: Pick<CatalogRun, "status" | "error"> & { summary?: OfferSummary }): Promise<void> {
  await db
    .update(catalogRunsTable)
    .set({ ...set, finishedAt: new Date() })
    .where(eq(catalogRunsTable.id, id));
}

/** Tiene solo le ultime 20 esecuzioni. */
async function pruneRuns(): Promise<void> {
  const keep = db
    .select({ id: catalogRunsTable.id })
    .from(catalogRunsTable)
    .orderBy(desc(catalogRunsTable.startedAt), desc(catalogRunsTable.id))
    .limit(KEEP_RUNS);
  await db.delete(catalogRunsTable).where(notInArray(catalogRunsTable.id, keep));
}

async function executeRefresh(runId: number, fetchImpl: typeof fetch): Promise<void> {
  const names: SourceName[] = ["openrouter", "litellm"];
  const settled = await Promise.allSettled([fetchOpenRouterSource(fetchImpl), fetchLiteLlmSource(fetchImpl)]);
  const entries: SourceEntry[] = [];
  const failures: string[] = [];
  const failed: SourceName[] = [];
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") entries.push(...res.value);
    else {
      failed.push(names[i]!);
      // Un errore diverso da SourceError diventa comunque il messaggio fisso della fonte
      failures.push(res.reason instanceof SourceError ? res.reason.message : new SourceError(names[i]!).message);
    }
  });
  if (failures.length === names.length) {
    await finishRun(runId, { status: "failed", error: failures.join("; ") });
    return;
  }

  const now = new Date();
  const before = await loadOffers();
  const merged = mergeUniversal(entries, PROVIDER_REGISTRY, now);
  // Aggiornamento parziale: i dati della fonte caduta restano quelli precedenti
  const offers = keepFailedOfferFields(merged.offers, before, failed, now);
  const { newProviders, versions } = await writeCatalog({ ...merged, offers }, failed.length > 0, now);
  const accounts = await reverifyAccounts();
  await enrichFromCatalog(db, {});
  const summary: OfferSummary = {
    ...summarizeOffers(before, offers, (o) => versions.get(o.canonicalKey) ?? ""),
    newProviders,
    accounts,
  };
  await finishRun(runId, {
    status: failures.length ? "partial" : "completed",
    error: failures.length ? `aggiornamento parziale: ${failures[0]}` : null,
    summary,
  });
}

/**
 * Avvia un aggiornamento: inserisce la riga `running` (se ce n'è già una → `CatalogBusyError`) e
 * prosegue in background. `done` si risolve a esecuzione chiusa e non rigetta mai.
 */
export async function startCatalogRefresh(opts: {
  trigger: "scheduled" | "manual";
  userId: number | null;
  fetchImpl?: typeof fetch;
}): Promise<{ run: CatalogRun; done: Promise<void> }> {
  let run: CatalogRun;
  try {
    const [inserted] = await db
      .insert(catalogRunsTable)
      .values({ trigger: opts.trigger, userId: opts.userId, status: "running" })
      .returning();
    run = inserted!;
  } catch (err) {
    if (isUniqueViolation(err, "catalog_runs_one_running")) throw new CatalogBusyError();
    throw err;
  }

  const done = executeRefresh(run.id, opts.fetchImpl ?? fetch)
    .catch(async (err: unknown) => {
      logger.error({ catalogRunId: run.id, errName: err instanceof Error ? err.name : "unknown" }, "Aggiornamento del catalogo non riuscito");
      await finishRun(run.id, { status: "failed", error: UNEXPECTED_ERROR });
    })
    .then(pruneRuns)
    .catch((err: unknown) => {
      logger.error({ catalogRunId: run.id, errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dell'aggiornamento del catalogo non riuscita");
    });
  return { run, done };
}

/** All'avvio: le esecuzioni rimaste `running` sono state interrotte dal riavvio. */
export async function failInterruptedCatalogRuns(): Promise<number> {
  const rows = await db
    .update(catalogRunsTable)
    .set({ status: "failed", error: INTERRUPTED_ERROR, finishedAt: new Date() })
    .where(eq(catalogRunsTable.status, "running"))
    .returning({ id: catalogRunsTable.id });
  return rows.length;
}
