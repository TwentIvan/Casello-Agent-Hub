// Rianalisi incrementale dopo ogni merge (issue #113). Per le App con `auto_reanalysis` e codice da GitHub tramite
// installazione Botcave legge lo SHA del branch base (gratis, una chiamata a GitHub, nessun modello) e, quando cambia,
// mette in coda un'analisi completa con l'agente locale (`executor: local`, nessun costo per Botcave). Il confronto
// con lo stato attuale dell'app (`diff`: new/changed/unchanged/removed) mostra poi solo le novità da rivedere.
// Controllo ogni 30 minuti e subito dopo ogni merge di Botcave sul base (`requestReanalysisCheck`).
// Nei log solo id, sha a 7 ed esito.

import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db, analysesTable, appsTable, type App } from "@workspace/db";
import { installationToken } from "../github/app";
import { fetchBranchSha } from "../github/commit";
import { githubConfig } from "../github/config";
import { logger } from "../logger";
import { AnalysisBusyError, insertLocalAnalysis } from "../architect/start";

export const REANALYSIS_CHECK_MS = 1_800_000;
const REANALYSIS_FIRST_CHECK_MS = 90_000;
export const REANALYSIS_APPS_PER_ROUND = 20;
/** Un'analisi automatica che nessun agente locale prende entro 24 ore si chiude: non deve bloccare l'App per sempre. */
export const REANALYSIS_UNCLAIMED_MS = 24 * 3_600_000;

export const REANALYSIS_MESSAGES = {
  unclaimed: "rianalisi automatica non presa in carico da un agente locale entro 24 ore",
} as const;

export type CheckOutcome = "not_eligible" | "sha_error" | "baseline" | "unchanged" | "busy" | "queued";

export interface ReanalysisDeps {
  /** SHA del branch base dell'App; lancia se GitHub non risponde o l'accesso manca. */
  readSha: (app: App) => Promise<string>;
}

async function readShaFromGithub(app: App): Promise<string> {
  const cfg = githubConfig();
  if (!cfg) throw new Error("GitHub non configurato");
  const token = await installationToken(cfg, app.sourceInstallationId!, { repo: app.sourceRepo!, permissions: { contents: "read" } });
  return fetchBranchSha({ apiBase: cfg.apiBase, repo: app.sourceRepo!, branch: app.sourceBranch, token });
}

let deps: ReanalysisDeps = { readSha: readShaFromGithub };

/** Solo per i test: sostituisce la lettura dello SHA (null = GitHub vero). */
export function setReanalysisDepsForTests(next: Partial<ReanalysisDeps> | null): void {
  deps = next ? { ...deps, ...next } : { readSha: readShaFromGithub };
}

export function reanalysisEligible(app: App): boolean {
  return app.autoReanalysis && app.sourceType === "github" && !!app.sourceRepo && app.sourceInstallationId != null;
}

/** Commit dell'ultima analisi conclusa dell'App (quello letto dall'agente o, se manca, quello che l'ha avviata). */
async function lastAnalysedCommit(appId: number): Promise<string | null> {
  const [row] = await db
    .select({ commit: sql<string | null>`coalesce(${analysesTable.sourceCommit}, ${analysesTable.triggerCommit})` })
    .from(analysesTable)
    .where(and(eq(analysesTable.appId, appId), eq(analysesTable.status, "completed")))
    .orderBy(desc(analysesTable.createdAt), desc(analysesTable.id))
    .limit(1);
  return row?.commit?.toLowerCase() ?? null;
}

/**
 * Un controllo: legge lo SHA del base e lo confronta con l'ultimo già gestito (`reanalysis_seen_sha`, altrimenti il
 * commit dell'ultima analisi conclusa). Senza alcun riferimento lo SHA diventa la linea di partenza (nessuna analisi:
 * la prima la avvia l'utente). SHA nuovo → analisi locale in coda con `trigger_commit`; con un'analisi già aperta
 * per l'App lo SHA non si segna, così si riprova al controllo dopo.
 */
export async function checkReanalysis(app: App): Promise<CheckOutcome> {
  if (!reanalysisEligible(app)) return "not_eligible";
  const touch = (seen?: string) =>
    db
      .update(appsTable)
      .set({ reanalysisCheckedAt: new Date(), ...(seen ? { reanalysisSeenSha: seen } : {}) })
      .where(eq(appsTable.id, app.id));
  let sha: string;
  try {
    sha = (await deps.readSha(app)).toLowerCase();
  } catch (err) {
    await touch();
    logger.info({ appId: app.id, outcome: "sha_error", errName: err instanceof Error ? err.name : "Error" }, "Rianalisi automatica: SHA non letto");
    return "sha_error";
  }
  const reference = app.reanalysisSeenSha?.toLowerCase() ?? (await lastAnalysedCommit(app.id));
  if (reference === null) {
    await touch(sha);
    return "baseline";
  }
  if (reference === sha) {
    await touch(sha);
    return "unchanged";
  }
  try {
    const analysis = await insertLocalAnalysis(app, { bestPractice: false, triggerCommit: sha });
    await touch(sha);
    logger.info({ appId: app.id, analysisId: analysis.id, sha7: sha.slice(0, 7) }, "Rianalisi automatica in coda per l'agente locale");
    return "queued";
  } catch (err) {
    if (!(err instanceof AnalysisBusyError)) throw err;
    await touch();
    return "busy";
  }
}

/** Analisi automatiche mai prese in carico da oltre 24 ore → `failed`: liberano l'App per le analisi dell'utente. */
export async function expireUnclaimedReanalyses(now = new Date()): Promise<number> {
  const rows = await db
    .update(analysesTable)
    .set({ status: "failed", error: REANALYSIS_MESSAGES.unclaimed, finishedAt: now })
    .where(
      and(
        eq(analysesTable.status, "queued"),
        eq(analysesTable.executor, "local"),
        isNotNull(analysesTable.triggerCommit),
        lt(analysesTable.createdAt, new Date(now.getTime() - REANALYSIS_UNCLAIMED_MS)),
      ),
    )
    .returning({ id: analysesTable.id });
  return rows.length;
}

/** Un giro: chiude le analisi automatiche scadute e controlla al più 20 App idonee, le meno recenti prima. */
export async function runReanalysisRound(): Promise<number> {
  await expireUnclaimedReanalyses();
  const apps = await db
    .select()
    .from(appsTable)
    .where(
      and(
        eq(appsTable.autoReanalysis, true),
        eq(appsTable.sourceType, "github"),
        isNotNull(appsTable.sourceRepo),
        isNotNull(appsTable.sourceInstallationId),
      ),
    )
    .orderBy(sql`${appsTable.reanalysisCheckedAt} asc nulls first`, asc(appsTable.id))
    .limit(REANALYSIS_APPS_PER_ROUND);
  for (const app of apps) {
    try {
      await checkReanalysis(app);
    } catch (err) {
      logger.error({ appId: app.id, errName: err instanceof Error ? err.name : "Error" }, "Controllo della rianalisi automatica non riuscito");
    }
  }
  return apps.length;
}

const background = new Set<Promise<unknown>>();

/**
 * Dopo un merge sul base fatto da Botcave: controllo subito, in background e senza eccezioni (mai a scapito del merge).
 * Senza `auto_reanalysis` non fa nulla.
 */
export function requestReanalysisCheck(appId: number): void {
  const p = (async () => {
    const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
    if (app && reanalysisEligible(app)) await checkReanalysis(app);
  })()
    .catch((err: unknown) =>
      logger.error({ appId, errName: err instanceof Error ? err.name : "Error" }, "Controllo della rianalisi automatica non riuscito"),
    )
    .finally(() => background.delete(p));
  background.add(p);
}

/** Solo per i test: attende i controlli in background. */
export async function waitReanalysisIdleForTests(): Promise<void> {
  while (background.size > 0) await Promise.all([...background]);
}

/** Avvia il giro periodico; risponde con la funzione che lo ferma. */
export function startReanalysisScheduler(): () => void {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const count = await runReanalysisRound();
      if (count > 0) logger.info({ count }, "Giro della rianalisi automatica concluso");
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Giro della rianalisi automatica non riuscito");
    } finally {
      checking = false;
    }
  };
  const first = setTimeout(() => void check(), REANALYSIS_FIRST_CHECK_MS);
  const timer = setInterval(() => void check(), REANALYSIS_CHECK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
