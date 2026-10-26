// Orchestrazione di un'analisi dell'architetto, eseguita in background nel processo dell'API:
// carica le sorgenti (solo in memoria), esegue le sei fasi in ordine, salva mappa, elementi
// della proposta, log e token. Ogni uscita chiude l'analisi come completed, failed o
// interrupted: nessuna resta `running`.
//
// Il token GitHub (manuale, decifrato, o di installazione dell'App, ristretto al repo) esiste solo
// in memoria subito prima del download e non compare mai in log, `error`, `sources` o eccezioni.
// Degli errori sconosciuti non si salva il messaggio (potrebbe contenere URL o dati): solo un
// testo generico in italiano.

import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, inArray } from "drizzle-orm";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
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
import { ProviderError } from "../ai/discovery";
import { ModelAccessError, modelChat as executorChat, resolveModel, type ResolvedModel } from "../ai/executor";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { GITHUB_MESSAGES, GithubError, forgetInstallationTokens, installationToken } from "../github/app";
import { githubConfig, type GithubConfig } from "../github/config";
import { loadAppConnection } from "../tools/catalog";
import { diffAgents, diffAlwaysNew, diffSkills, diffTools, type DiffEntry } from "./diff";
import { PHASE_TOKEN_SHARES, runPhase, type PhaseBudget } from "./phase-loop";
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

export const ANALYSIS_DEFAULT_MAX_TOKENS = 1_000_000;
export const ANALYSIS_MAX_MS = 1_800_000;
/** Voci massime del log di un'analisi: si tengono le più recenti. */
export const ANALYSIS_LOG_MAX = 500;

// Ogni chiamata al modello dura almeno 1 s, poi la limita la scadenza dell'analisi
const MIN_MODEL_CALL_MS = 1_000;
// Tetto della singola richiesta al modello: gli esiti delle fasi (es. il catalogo) sono JSON lunghi
// e i 120 s delle run degli agenti non bastano. Il limite effettivo è min(questo, tempo rimasto).
export const ARCHITECT_MODEL_TIMEOUT_MS = 300_000;
// Nuovi tentativi: l'SDK non ne fa (maxRetries 0), altrimenti ritenterebbe anche i timeout e un
// modello lento costerebbe 2-3 volte l'attesa. Qui si ritenta una sola volta, dopo una breve pausa,
// solo per errori di rete diversi dal timeout e per le risposte 5xx del gateway.
const MODEL_RETRY_DELAY_MS = 1_000;
// Limite di richieste del provider (429, es. piano gratuito di Gemini): si aspetta e si riprova fino a
// queste volte, con l'attesa indicata dal provider o con queste pause, sempre entro la scadenza
// dell'analisi. Le richieste rifiutate non costano.
const RATE_LIMIT_DELAYS_MS = [15_000, 30_000, 60_000, 60_000, 60_000];
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
  /** Solo per i test: host delle API GitHub (token manuale). */
  githubApiBase?: string;
  /** Solo per i test: configurazione della GitHub App (null = non configurata); default githubConfig(). */
  githubConfig?: GithubConfig | null;
  /** Solo per i test: durata massima dell'analisi (default ANALYSIS_MAX_MS). */
  maxMs?: number;
  /** Solo per i test: tetto della singola chiamata al modello (default ARCHITECT_MODEL_TIMEOUT_MS). */
  modelTimeoutMs?: number;
  /** Solo per i test: pausa prima del nuovo tentativo di una chiamata al modello (default 1 s). */
  modelRetryDelayMs?: number;
  /** Solo per i test: pause tra i nuovi tentativi dopo un 429 (default RATE_LIMIT_DELAYS_MS). */
  rateLimitDelaysMs?: number[];
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

const BRANCH_NOT_FOUND = "repository o branch non trovato: controlla il branch nelle sorgenti dell'app";

/**
 * Codice dal repo tramite l'installazione della GitHub App: token ristretto al repo e a
 * `contents: read`, generato subito prima del download. 401 sul download con quel token vuol dire
 * accesso revocato: si scarta il token in cache e si usa il messaggio della spec; 404 vuol dire
 * repo o branch inesistente.
 */
async function fetchViaInstallation(app: App & { sourceRepo: string }, installationId: number, opts: StartAnalysisOptions): Promise<SourceTree> {
  const cfg = opts.githubConfig !== undefined ? opts.githubConfig : githubConfig();
  if (!cfg) throw new AnalysisError(GITHUB_MESSAGES.notConfigured);
  let token: string;
  try {
    token = await installationToken(cfg, installationId, { repo: app.sourceRepo });
  } catch (err) {
    if (err instanceof GithubError) throw new AnalysisError(err.message);
    throw err;
  }
  try {
    return await fetchGithubTree({ repo: app.sourceRepo, branch: app.sourceBranch, token, apiBase: cfg.apiBase });
  } catch (err) {
    if (err instanceof SourceError && err.status === 401) {
      forgetInstallationTokens(installationId);
      throw new AnalysisError(GITHUB_MESSAGES.noAccess);
    }
    // Il token appena emesso è ristretto proprio a questo repo: l'installazione lo vede, quindi un
    // 404 vuol dire repo o branch inesistente, non accesso perso (il token resta valido)
    if (err instanceof SourceError && err.status === 404) throw new AnalysisError(BRANCH_NOT_FOUND);
    throw err;
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

/**
 * Costo dell'analisi: somma dei costi delle chiamate; parziale (null) se una chiamata con token non
 * ha costo (prezzo mancante o vecchio gateway).
 */
export class CostTracker {
  private total = 0;
  private partial = false;
  private calls = 0;

  add(reply: ChatResult & { costUsd?: number | null }): void {
    this.calls += 1;
    if (reply.costUsd == null) {
      if (reply.promptTokens + reply.completionTokens > 0) this.partial = true;
    } else {
      this.total += reply.costUsd;
    }
  }

  /** Valore per la colonna numeric: null se parziale o senza chiamate. */
  value(): string | null {
    if (this.partial || this.calls === 0 || !Number.isFinite(this.total)) return null;
    return String(Math.round(this.total * 1e8) / 1e8);
  }
}

class ProgressWriter {
  private log: AnalysisLogEntry[];
  private unsaved = 0;
  private chain: Promise<void> = Promise.resolve();
  phase: PhaseName | null = null;

  constructor(
    private readonly analysisId: number,
    initial: AnalysisLogEntry[],
    private readonly budget: PhaseBudget,
    private readonly cost: CostTracker,
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
      costUsd: this.cost.value(),
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
    } else if (app.sourceType === "github" && app.sourceInstallationId != null) {
      // Tramite l'installazione della GitHub App: nessun token manuale
      if (!app.sourceRepo) throw new AnalysisError("sorgente GitHub senza repo: imposta owner/nome nelle sorgenti dell'app");
      tree = await fetchViaInstallation({ ...app, sourceRepo: app.sourceRepo }, app.sourceInstallationId, opts);
      code = "github";
      log(`codice: GitHub ${app.sourceRepo} tramite l'App (${tree.fileCount} file)`);
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

/** Durata breve in secondi per i messaggi: "300 s", oppure "0.3 s" sotto il secondo. */
function formatSeconds(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)} s` : `${Math.round(ms / 100) / 10} s`;
}

/**
 * Errori transitori per cui vale un nuovo tentativo: rete (non timeout) e 5xx. Per l'esecutore dei
 * modelli: `unreachable` senza stato (rete, risposta malformata) o con stato 5xx; mai i 3xx, i 4xx,
 * le chiavi non valide né i timeout (che l'esecutore non converte).
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.kind === "unreachable" && (err.status === null || err.status >= 500);
  if (err instanceof APIConnectionTimeoutError) return false;
  if (err instanceof APIConnectionError) return true;
  return err instanceof APIError && typeof err.status === "number" && err.status >= 500;
}

// Suggerimenti del vecchio percorso (gateway): con l'esecutore i messaggi di ProviderError sono già specifici
const STATUS_HINTS: Record<number, string> = {
  400: " (richiesta rifiutata: spesso contesto troppo lungo per il modello)",
  402: " (credito del provider esaurito: ricarica il conto o scegli un altro modello)",
  429: " (limite di richieste: riprova più tardi)",
};

interface ModelChatOptions {
  model: string;
  /** Modello risolto dell'analisi (account AI); null = vecchio percorso del gateway. */
  resolved: ResolvedModel | null;
  cost: CostTracker;
  analysisId: number;
  deadline: number;
  maxMs: number;
  timeoutMs: number;
  retryDelayMs: number;
  rateLimitDelaysMs: number[];
  log: (message: string) => void;
  now: () => number;
}

function architectChat({
  model,
  resolved,
  cost,
  analysisId,
  deadline,
  maxMs,
  timeoutMs,
  retryDelayMs,
  rateLimitDelaysMs,
  log,
  now,
}: ModelChatOptions) {
  return async (messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ChatResult> => {
    // La chiamata non può superare la scadenza complessiva (minimo 1 s)
    const signal = AbortSignal.timeout(Math.max(MIN_MODEL_CALL_MS, deadline - now()));
    const options = {
      messages,
      tools,
      caller: "architect",
      maxTokens: MAX_COMPLETION_TOKENS,
      temperature: MODEL_TEMPERATURE,
      signal,
      timeoutMs,
      maxRetries: 0,
    };
    const send = async (): Promise<ChatResult> => {
      const reply = resolved ? await executorChat(resolved, options) : await aiGateway.chat({ modelKey: model, ...options });
      cost.add(reply);
      return reply;
    };
    // Limite di richieste: attesa (quella del provider o la pausa successiva) e nuovo tentativo, finché
    // ci sono tentativi e l'attesa finisce prima della scadenza; altrimenti l'errore passa così com'è
    const call = async (): Promise<ChatResult> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await send();
        } catch (err) {
          if (!(err instanceof ProviderError) || err.kind !== "rate" || attempt >= rateLimitDelaysMs.length) throw err;
          const wait = err.retryAfterMs ?? rateLimitDelaysMs[attempt]!;
          if (now() + wait >= deadline) throw err;
          log(`limite di richieste del provider: nuovo tentativo tra ${Math.max(1, Math.ceil(wait / 1000))} s (${attempt + 1} di ${rateLimitDelaysMs.length})`);
          await sleep(wait, undefined, { signal });
        }
      }
    };
    try {
      try {
        return await call();
      } catch (err) {
        if (signal.aborted || !isRetryable(err)) throw err;
        logger.warn({ analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Chiamata al modello dell'architetto non riuscita: nuovo tentativo");
        await sleep(retryDelayMs, undefined, { signal });
        return await call();
      }
    } catch (err) {
      // Messaggi propri: quelli del gateway o dell'SDK potrebbero contenere URL
      if (signal.aborted) {
        throw new AnalysisError(`tempo massimo dell'analisi (${formatDuration(maxMs)}) scaduto durante la chiamata al modello`);
      }
      logger.warn({ analysisId, errName: err instanceof Error ? err.name : "unknown" }, "Chiamata al modello dell'architetto non riuscita");
      if (err instanceof APIConnectionTimeoutError) {
        throw new AnalysisError(`il modello non ha risposto entro ${formatSeconds(timeoutMs)} (riprova o scegli un modello più veloce)`);
      }
      // Esecutore dei modelli: messaggio fisso già in italiano e specifico (credito, chiave, HTTP 400…)
      if (err instanceof ProviderError) throw new AnalysisError(err.message);
      if (err instanceof APIError && typeof err.status === "number") {
        throw new AnalysisError(`il gateway dei modelli ha risposto con errore ${err.status}${STATUS_HINTS[err.status] ?? ""}`);
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
  const cost = new CostTracker();
  const progress = new ProgressWriter(analysisId, analysis.log ?? [], budget, cost);
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

    // Modello dell'analisi risolto una volta all'avvio (chi l'ha avviata l'ha già scelto tra i suoi
    // o quelli di sistema). La chiave resta in memoria nell'oggetto risolto, mai copiato.
    let resolved: ResolvedModel | null = null;
    if (analysis.aiModelId !== null) {
      try {
        resolved = await resolveModel(analysis.aiModelId, { userId: null, mustOwn: false });
      } catch (err) {
        if (err instanceof ModelAccessError || err instanceof ProviderError) throw new AnalysisError(err.message);
        throw err;
      }
    }

    const loaded = await loadSources(app, opts, log);
    tree = loaded.tree;
    const { openapi, sources } = loaded;
    await progress.flush({ sources });

    // Senza codice né OpenAPI i tool derivano solo dalla descrizione: vanno sempre verificati
    const forceVerification = sources.code === "none" && !sources.openapi;
    const chat = architectChat({
      model: analysis.model,
      resolved,
      cost,
      analysisId,
      deadline: budget.deadline,
      maxMs,
      timeoutMs: opts.modelTimeoutMs ?? ARCHITECT_MODEL_TIMEOUT_MS,
      retryDelayMs: opts.modelRetryDelayMs ?? MODEL_RETRY_DELAY_MS,
      rateLimitDelaysMs: opts.rateLimitDelaysMs ?? RATE_LIMIT_DELAYS_MS,
      log,
      now,
    });
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
      // Quota morbida della fase: solo il sollecito a consegnare; il tetto rigido resta il totale
      const phaseQuota = Math.floor(PHASE_TOKEN_SHARES[phase] * budget.maxTokens);
      const outcome = await runPhase({ phase, system: SYSTEM_BASE, user, tree, openapi, chat, budget, phaseQuota, log, now });
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
