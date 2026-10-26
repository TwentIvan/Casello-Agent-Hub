import { and, asc, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import {
  db,
  aiAccountsTable,
  aiModelsTable,
  catalogRunsTable,
  modelCatalogTable,
  type CatalogModelRow,
  type CatalogRun,
} from "@workspace/db";
import { logger } from "../logger";
import { isUniqueViolation } from "../pg-errors";
import { enrichFromCatalog, verifyAccount } from "../ai/accounts";
import { fetchLiteLlmSource, fetchOpenRouterSource, SourceError, type SourceEntry, type SourceName } from "./sources";
import { mergeCatalog, type CatalogRecord } from "./merge";
import { summarizeCatalog, type CatalogSummary } from "./summary";

// Aggiornamento del catalogo: scarica le fonti, aggiorna `model_catalog`, riverifica gli account degli
// utenti, arricchisce i loro modelli e registra il riepilogo in `catalog_runs`. Una sola esecuzione alla
// volta (indice unico parziale sulla riga `running`). Errori sempre a testo fisso: mai chiavi, URL o
// messaggi grezzi di fonti e provider.

const KEEP_RUNS = 20;
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

/** Riga del DB nella forma della fusione, per il confronto del riepilogo. */
function toRecord(r: CatalogModelRow): CatalogRecord {
  return {
    provider: r.provider,
    modelId: r.modelId,
    family: r.family,
    version: r.version,
    releasedAt: r.releasedAt,
    priceInput: toNumber(r.priceInputPerMtok),
    priceOutput: toNumber(r.priceOutputPerMtok),
    contextTokens: r.contextTokens,
    supportsTools: r.supportsTools,
    status: r.status,
    deprecationDate: r.deprecationDate,
    sources: r.sources as CatalogRecord["sources"],
  };
}

/** Inserisce o aggiorna le righe delle fonti; quelle assenti dalle fonti restano come sono. */
async function upsertCatalog(records: CatalogRecord[]): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    for (let i = 0; i < records.length; i += 500) {
      await tx
        .insert(modelCatalogTable)
        .values(
          records.slice(i, i + 500).map((r) => ({
            provider: r.provider,
            modelId: r.modelId,
            family: r.family,
            version: r.version,
            releasedAt: r.releasedAt,
            priceInputPerMtok: toPrice(r.priceInput),
            priceOutputPerMtok: toPrice(r.priceOutput),
            contextTokens: r.contextTokens,
            supportsTools: r.supportsTools,
            status: r.status,
            deprecationDate: r.deprecationDate,
            sources: r.sources,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [modelCatalogTable.provider, modelCatalogTable.modelId],
          set: {
            family: sql`excluded.family`,
            version: sql`excluded.version`,
            releasedAt: sql`excluded.released_at`,
            priceInputPerMtok: sql`excluded.price_input_per_mtok`,
            priceOutputPerMtok: sql`excluded.price_output_per_mtok`,
            contextTokens: sql`excluded.context_tokens`,
            supportsTools: sql`excluded.supports_tools`,
            status: sql`excluded.status`,
            deprecationDate: sql`excluded.deprecation_date`,
            sources: sql`excluded.sources`,
            updatedAt: now,
          },
        });
    }
  });
}

/**
 * Rilegge `/models` di ogni account degli utenti (non quello di sistema), uno alla volta: un errore non
 * ferma gli altri. Riporta i modelli scoperti prima e non più elencati, solo per le verifiche riuscite
 * con un elenco non vuoto.
 */
async function reverifyAccounts(): Promise<CatalogSummary["accounts"]> {
  const accounts = await db.select().from(aiAccountsTable).where(isNotNull(aiAccountsTable.userId)).orderBy(asc(aiAccountsTable.id));
  const out: CatalogSummary["accounts"] = [];
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

async function finishRun(id: number, set: Pick<CatalogRun, "status" | "error"> & { summary?: CatalogSummary }): Promise<void> {
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
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") entries.push(...res.value);
    // Un errore diverso da SourceError diventa comunque il messaggio fisso della fonte
    else failures.push(res.reason instanceof SourceError ? res.reason.message : new SourceError(names[i]!).message);
  });
  if (failures.length === names.length) {
    await finishRun(runId, { status: "failed", error: failures.join("; ") });
    return;
  }

  const records = mergeCatalog(entries, new Date());
  const before = (await db.select().from(modelCatalogTable)).map(toRecord);
  await upsertCatalog(records);
  const accounts = await reverifyAccounts();
  await enrichFromCatalog(db, {});
  const summary: CatalogSummary = { ...summarizeCatalog(before, records), accounts };
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
