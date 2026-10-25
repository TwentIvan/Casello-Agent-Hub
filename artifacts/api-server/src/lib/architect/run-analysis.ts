// Orchestrazione di un'analisi dell'architetto, eseguita in background nel processo dell'API:
// carica le sorgenti (solo in memoria), esegue le sei fasi in ordine, salva mappa, elementi
// della proposta, log e token. Ogni uscita chiude l'analisi come completed, failed o
// interrupted: nessuna resta `running`.
//
// Il token GitHub viene decifrato solo in memoria subito prima del download e non compare mai
// in log, `error`, `sources` o eccezioni. Degli errori sconosciuti non si salva il messaggio
// (potrebbe contenere URL o dati): solo un testo generico in italiano.

import { and, eq, inArray } from "drizzle-orm";
import { APIError } from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import {
  db,
  agentSkillsTable,
  agentToolsTable,
  agentsTable,
  analysesTable,
  analysisItemsTable,
  appToolsTable,
  appsTable,
  type Analysis,
  type AnalysisLogEntry,
  type AnalysisSources,
  type App,
} from "@workspace/db";
import { aiGateway, type ChatResult } from "../ai-gateway";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { loadAppConnection } from "../tools/catalog";
import { diffAgents, diffAlwaysNew, diffSkills, diffTools, type DiffEntry } from "./diff";
import { runPhase, type PhaseBudget } from "./phase-loop";
import { phasePrompt, SYSTEM_BASE } from "./prompts";
import {
  PHASES,
  type AgentsResult,
  type AnalysisChapter,
  type CatalogResult,
  type CompletionResult,
  type EvolutionResult,
  type PhaseName,
} from "./schemas";
import { SourceTree, SourceTreeError } from "./source-tree";
import { fetchGithubTree, fetchOpenApi, SourceError, type OpenApiDoc } from "./sources";

export const ANALYSIS_DEFAULT_MAX_TOKENS = 400_000;
export const ANALYSIS_MAX_MS = 1_800_000;
/** Voci massime del log di un'analisi: si tengono le più recenti. */
export const ANALYSIS_LOG_MAX = 500;

// Ogni chiamata al modello dura almeno 1 s, poi la limita la scadenza dell'analisi
const MIN_MODEL_CALL_MS = 1_000;
// Tetto dei token generati per singola risposta (gli esiti delle fasi possono essere lunghi)
const MAX_COMPLETION_TOKENS = 16_000;
const MODEL_TEMPERATURE = 0.2;
// Il log si scrive nel DB a blocchi: ogni LOG_FLUSH_EVERY voci e a ogni fine fase, non a ogni chiamata
const LOG_FLUSH_EVERY = 10;

const GENERIC_ERROR = "Errore interno durante l'analisi.";
const INTERRUPTED_ERROR = "Analisi interrotta dal riavvio del server.";

export interface StartAnalysisOptions {
  /** Archivio caricato dall'utente: resta solo in memoria. */
  zip?: Uint8Array;
  /** Solo per i test: host delle API GitHub. */
  githubApiBase?: string;
  /** Solo per i test: durata massima dell'analisi (default ANALYSIS_MAX_MS). */
  maxMs?: number;
  /** Solo per i test: orologio. */
  now?: () => number;
}

/** Aggiunge voci al log tenendo al massimo ANALYSIS_LOG_MAX voci, le più recenti. */
export function appendLog(log: AnalysisLogEntry[], entries: AnalysisLogEntry[]): AnalysisLogEntry[] {
  const next = log.concat(entries);
  return next.length > ANALYSIS_LOG_MAX ? next.slice(next.length - ANALYSIS_LOG_MAX) : next;
}

/** Errore con messaggio in italiano, già sicuro da salvare in `error`. */
class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

function safeMessage(err: unknown): string {
  if (err instanceof AnalysisError || err instanceof SourceError || err instanceof SourceTreeError) {
    return err.message;
  }
  return GENERIC_ERROR;
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minuti` : `${Math.round(ms / 100) / 10} s`;
}

// --- Stato in scrittura: log, fase e token, salvati a blocchi -----------------------------------

class ProgressWriter {
  private log: AnalysisLogEntry[];
  private unsaved = 0;
  private chain: Promise<void> = Promise.resolve();
  phase: PhaseName | null = null;

  constructor(
    private readonly analysisId: number,
    initial: AnalysisLogEntry[],
    private readonly budget: PhaseBudget,
  ) {
    this.log = initial;
  }

  /** Voce di log della fase corrente; la scrittura nel DB avviene a blocchi. */
  add(message: string): void {
    this.log = appendLog(this.log, [{ at: new Date().toISOString(), phase: this.phase ?? "sorgenti", message }]);
    this.unsaved += 1;
    if (this.unsaved >= LOG_FLUSH_EVERY) void this.flush().catch(() => {});
  }

  /** Scrive log, fase e token; le scritture sono in fila, mai sovrapposte. */
  flush(extra: Partial<typeof analysesTable.$inferInsert> = {}): Promise<void> {
    this.unsaved = 0;
    const snapshot = {
      log: this.log,
      phase: this.phase,
      tokensUsed: this.budget.tokensUsed,
      ...extra,
    };
    const write = async () => {
      await db.update(analysesTable).set(snapshot).where(eq(analysesTable.id, this.analysisId));
    };
    const next = this.chain.then(write, write);
    // La catena prosegue anche se una scrittura fallisce; chi attende `flush` vede l'errore
    this.chain = next.catch((err: unknown) => {
      logger.error({ analysisId: this.analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Scrittura del log dell'analisi non riuscita");
    });
    return next;
  }

  /** Attende le scritture in corso. */
  settle(): Promise<void> {
    return this.chain;
  }
}

// --- Sorgenti -------------------------------------------------------------------------------

interface LoadedSources {
  tree: SourceTree | null;
  openapi: OpenApiDoc | null;
  sources: AnalysisSources;
}

async function loadSources(app: App, opts: StartAnalysisOptions, log: (m: string) => void): Promise<LoadedSources> {
  let tree: SourceTree | null = null;
  let code: AnalysisSources["code"] = "none";
  try {
    if (opts.zip) {
      tree = SourceTree.fromZip(opts.zip, { stripTopFolder: true });
      code = "zip";
      log(`codice: archivio zip (${tree.fileCount} file)`);
    } else if (app.sourceType === "github") {
      if (!app.sourceRepo) throw new AnalysisError("sorgente GitHub senza repo: imposta owner/nome nelle sorgenti dell'app");
      if (!app.sourceTokenEnc) throw new AnalysisError("sorgente GitHub senza token: imposta il token nelle sorgenti dell'app");
      let token: string;
      try {
        token = decryptSecret(app.sourceTokenEnc);
      } catch {
        throw new AnalysisError("token GitHub non leggibile: reimpostalo nelle sorgenti dell'app");
      }
      tree = await fetchGithubTree({
        repo: app.sourceRepo,
        branch: app.sourceBranch,
        token,
        ...(opts.githubApiBase ? { apiBase: opts.githubApiBase } : {}),
      });
      code = "github";
      log(`codice: GitHub ${app.sourceRepo}${app.sourceBranch ? ` (${app.sourceBranch})` : ""} (${tree.fileCount} file)`);
    } else if (app.sourceType === "zip") {
      throw new AnalysisError("archivio zip non fornito: carica lo zip del codice per avviare l'analisi");
    } else {
      log("codice: nessuno");
    }

    // OpenAPI: unica chiamata verso l'app (GET, senza credenziali)
    const conn = await loadAppConnection(app.id);
    const baseUrls = [conn.internalBaseUrl, conn.baseUrl].filter((u): u is string => !!u);
    const openapi = await fetchOpenApi({ openapiUrl: app.openapiUrl, baseUrls });
    log(openapi ? `OpenAPI: ${openapi.operations.length} operazioni` : "OpenAPI: non trovato");

    const description = !!app.functionalDescription?.trim();
    log(description ? "descrizione funzionale: presente" : "descrizione funzionale: assente");
    return { tree, openapi, sources: { code, openapi: openapi !== null, description } };
  } catch (err) {
    await tree?.dispose();
    throw err;
  }
}

// --- Stato attuale dell'app, per le differenze -------------------------------------------------

async function currentTools(appId: number) {
  return db.select().from(appToolsTable).where(eq(appToolsTable.appId, appId));
}

async function currentAgents(appId: number) {
  const agents = await db.select().from(agentsTable).where(eq(agentsTable.appId, appId));
  if (agents.length === 0) return [];
  const links = await db
    .select({ agentId: agentToolsTable.agentId, name: appToolsTable.name })
    .from(agentToolsTable)
    .innerJoin(appToolsTable, eq(agentToolsTable.toolId, appToolsTable.id))
    .where(inArray(agentToolsTable.agentId, agents.map((a) => a.id)));
  return agents.map((a) => ({ ...a, toolNames: links.filter((l) => l.agentId === a.id).map((l) => l.name) }));
}

async function currentSkills(appId: number) {
  const rows = await db
    .select({ skill: agentSkillsTable, agentRole: agentsTable.role, agentArea: agentsTable.area })
    .from(agentSkillsTable)
    .innerJoin(agentsTable, eq(agentSkillsTable.agentId, agentsTable.id))
    .where(eq(agentsTable.appId, appId));
  return rows.map((r) => ({ ...r.skill, agentRole: r.agentRole as string, agentArea: r.agentArea }));
}

type ChapterEntries = { chapter: AnalysisChapter; entries: DiffEntry<unknown>[] };

/** Elementi di una fase, calcolati rispetto allo stato attuale del DB. */
async function phaseItems(phase: PhaseName, result: unknown, appId: number): Promise<ChapterEntries[]> {
  switch (phase) {
    case "catalog": {
      const r = result as CatalogResult;
      return [
        { chapter: "tool", entries: diffTools(r.tools, await currentTools(appId)) },
        { chapter: "endpoint", entries: diffAlwaysNew({ chapter: "endpoint", items: r.endpoints }) },
      ];
    }
    case "agents": {
      const r = result as AgentsResult;
      return [
        { chapter: "agent", entries: diffAgents(r.agents, await currentAgents(appId)) },
        { chapter: "skill", entries: diffSkills(r.skills, await currentSkills(appId)) },
      ];
    }
    case "completion":
      return [{ chapter: "completion", entries: diffAlwaysNew({ chapter: "completion", items: (result as CompletionResult).items }) }];
    case "evolution":
      return [{ chapter: "evolution", entries: diffAlwaysNew({ chapter: "evolution", items: (result as EvolutionResult).items }) }];
    default:
      return [];
  }
}

function evidenceOf(payload: unknown): unknown[] {
  const ev = (payload as { evidence?: unknown } | null)?.evidence;
  return Array.isArray(ev) ? ev : [];
}

// --- Chiamata al modello con la scadenza dell'analisi ----------------------------------------

function modelChat(model: string, analysisId: number, deadline: number, maxMs: number, now: () => number) {
  return async (messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ChatResult> => {
    // La chiamata non può superare la scadenza complessiva (minimo 1 s)
    const signal = AbortSignal.timeout(Math.max(MIN_MODEL_CALL_MS, deadline - now()));
    try {
      return await aiGateway.chat({
        modelKey: model,
        messages,
        tools,
        caller: "architect",
        maxTokens: MAX_COMPLETION_TOKENS,
        temperature: MODEL_TEMPERATURE,
        signal,
      });
    } catch (err) {
      // Messaggi propri: quelli del gateway o dell'SDK potrebbero contenere URL
      if (signal.aborted) {
        throw new AnalysisError(`tempo massimo dell'analisi (${formatDuration(maxMs)}) scaduto durante la chiamata al modello`);
      }
      logger.warn({ analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Chiamata al modello dell'architetto non riuscita");
      if (err instanceof APIError && typeof err.status === "number") {
        throw new AnalysisError(`il gateway dei modelli ha risposto con errore ${err.status}`);
      }
      throw new AnalysisError("errore di comunicazione con il gateway dei modelli");
    }
  };
}

// --- Avvio -----------------------------------------------------------------------------------

/**
 * Esegue un'analisi `queued` fino alla fine. Da chiamare in background: non lancia mai.
 * Se l'analisi non esiste o non è `queued` (già presa in carico) non fa nulla.
 */
export async function startAnalysis(analysisId: number, opts: StartAnalysisOptions = {}): Promise<void> {
  const now = opts.now ?? Date.now;
  const maxMs = opts.maxMs ?? ANALYSIS_MAX_MS;

  let analysis: Analysis | undefined;
  try {
    [analysis] = await db
      .update(analysesTable)
      .set({ status: "running" })
      .where(and(eq(analysesTable.id, analysisId), eq(analysesTable.status, "queued")))
      .returning();
  } catch (err) {
    logger.error({ analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Avvio dell'analisi non riuscito");
    return;
  }
  if (!analysis) return;

  const budget: PhaseBudget = { tokensUsed: 0, maxTokens: analysis.maxTokens, deadline: now() + maxMs };
  const progress = new ProgressWriter(analysisId, analysis.log ?? [], budget);
  const log = (message: string) => progress.add(message);
  let tree: SourceTree | null = null;
  let closed = false;

  /** Chiusura condizionata: solo un'analisi ancora `running`. */
  const close = async (status: "completed" | "failed", error: string | null) => {
    await progress.settle();
    await db
      .update(analysesTable)
      .set({ status, error, finishedAt: new Date() })
      .where(and(eq(analysesTable.id, analysisId), eq(analysesTable.status, "running")));
    closed = true;
  };

  try {
    const [app] = await db.select().from(appsTable).where(eq(appsTable.id, analysis.appId)).limit(1);
    if (!app) throw new AnalysisError("app non trovata");

    const loaded = await loadSources(app, opts, log);
    tree = loaded.tree;
    const { openapi, sources } = loaded;
    await progress.flush({ sources });

    // Senza codice né OpenAPI i tool derivano solo dalla descrizione: vanno sempre verificati
    const forceVerification = sources.code === "none" && !sources.openapi;
    const chat = modelChat(analysis.model, analysisId, budget.deadline, maxMs, now);
    const previous: Partial<Record<PhaseName, unknown>> = {};
    let position = 0;

    for (const phase of PHASES) {
      progress.phase = phase;
      log(`inizio fase ${phase}`);
      await progress.flush();

      const user = phasePrompt(phase, {
        appName: app.name,
        baseUrl: app.baseUrl,
        functionalDescription: app.functionalDescription,
        hasCode: tree !== null,
        hasOpenApi: openapi !== null,
        previous,
      });
      const outcome = await runPhase({ phase, system: SYSTEM_BASE, user, tree, openapi, chat, budget, log, now });
      if (!outcome.ok) {
        log(`fase ${phase} non riuscita`);
        await progress.flush();
        await close("failed", outcome.error);
        return;
      }

      let result = outcome.result;
      if (phase === "catalog" && forceVerification) {
        const catalog = result as CatalogResult;
        result = { ...catalog, tools: catalog.tools.map((t) => ({ ...t, needsVerification: true })) };
      }
      previous[phase] = result;

      // Elementi della fase in un'unica INSERT, con `position` che prosegue nell'analisi
      const groups = await phaseItems(phase, result, app.id);
      const rows = groups.flatMap(({ chapter, entries }) =>
        entries.map((e) => ({
          analysisId,
          chapter,
          ref: e.ref,
          position: ++position,
          payload: e.payload,
          diff: e.diff,
          evidence: evidenceOf(e.payload),
        })),
      );
      if (rows.length > 0) await db.insert(analysisItemsTable).values(rows);

      log(`fase ${phase} conclusa${rows.length ? ` (${rows.length} elementi)` : ""}`);
      await progress.flush(phase === "map" ? { architectureMap: result } : {});
    }

    await close("completed", null);
  } catch (err) {
    if (!(err instanceof AnalysisError || err instanceof SourceError || err instanceof SourceTreeError)) {
      logger.error({ analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Analisi interrotta da un errore inatteso");
    }
    try {
      log("analisi non riuscita");
      await progress.flush().catch(() => {});
      await close("failed", safeMessage(err));
    } catch {
      // gestito nel finally
    }
  } finally {
    await tree?.dispose().catch(() => {});
    if (!closed) {
      // Ultimo tentativo: nessuna analisi resta `running`
      await db
        .update(analysesTable)
        .set({ status: "failed", error: GENERIC_ERROR, finishedAt: new Date() })
        .where(and(eq(analysesTable.id, analysisId), eq(analysesTable.status, "running")))
        .catch((err: unknown) =>
          logger.error({ analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dell'analisi non riuscita"),
        );
    }
  }
}

/**
 * Le analisi girano nel processo dell'API: dopo un riavvio quelle in coda o in corso non
 * finiranno mai. All'avvio si chiudono come `interrupted`; gli elementi già salvati restano.
 */
export async function failInterruptedAnalyses(): Promise<number> {
  const rows = await db
    .update(analysesTable)
    .set({ status: "interrupted", error: INTERRUPTED_ERROR, finishedAt: new Date() })
    .where(inArray(analysesTable.status, ["queued", "running"]))
    .returning({ id: analysesTable.id });
  return rows.length;
}
