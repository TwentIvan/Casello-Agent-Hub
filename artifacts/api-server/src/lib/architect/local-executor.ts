// Analisi dell'architetto eseguite da un agente locale (Claude Code sul Mac dell'utente, via MCP):
// coda, lease e consegna fase per fase. Casello non scarica il codice né chiama modelli: l'agente
// legge il proprio clone, riceve le istruzioni della fase e consegna l'esito, che qui si valida con
// gli stessi schemi Zod del percorso cloud e si registra con `recordPhaseResult`.
//
// Tutto ciò che arriva dall'agente (etichetta, motivo, esito, commit) è dato non attendibile: si
// valida e nei log del server finiscono solo id, nomi di fase e conteggi. Il token della lease esiste
// in chiaro solo nella risposta al claim; a riposo c'è il suo SHA-256.

import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  db,
  analysesTable,
  analysisItemsTable,
  analysisPhaseResultsTable,
  appsTable,
  type Analysis,
  type App,
} from "@workspace/db";
import { logger } from "../logger";
import { formatIssues } from "./phase-loop";
import { recordPhaseResult } from "./phase-record";
import { phasePrompt, SYSTEM_BASE } from "./prompts";
import { appendLog } from "./run-analysis";
import { PHASES, PHASE_SCHEMAS, type AnalysisChapter, type PhaseName } from "./schemas";

/** Durata della lease: rinnovata da ogni consegna e da ogni ping. */
export const LOCAL_LEASE_MS = 900_000;
/** Valore di `analyses.model` per le analisi locali (nessun modello di Casello, `ai_model_id` nullo). */
export const LOCAL_MODEL = "agente-locale";
/** Ogni quanto il job rimette in coda le analisi con la lease scaduta. */
export const LOCAL_LEASE_JOB_MS = 60_000;

export const LABEL_MAX_CHARS = 100;
export const REASON_MAX_CHARS = 300;

/** Premessa del prompt di sistema per l'agente locale (testo fisso). */
export const LOCAL_PREFACE =
  "Esegui questa fase con i tuoi strumenti sul clone locale del repository: gli strumenti di lettura citati sotto (list_dir, read_file, read_files, search) corrispondono ai tuoi. Consegna l'esito con lo strumento submit_phase di Casello, non con submit_result.";

// Messaggi fissi per l'agente (spec §8)
export const LOCAL_MESSAGES = {
  notFound: "analisi non trovata o non tua",
  leaseExpired: "lease scaduta: chiedi di nuovo il compito",
  invalidLabel: `etichetta non valida: da 1 a ${LABEL_MAX_CHARS} caratteri`,
  invalidReason: `motivo non valido: da 1 a ${REASON_MAX_CHARS} caratteri`,
} as const;

const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/** Errore per l'agente locale: il messaggio è fisso e sicuro da restituire. */
export class LocalAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAnalysisError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LocalAppCard {
  name: string;
  functionalDescription: string | null;
  baseUrl: string;
  /** Solo per le sorgenti GitHub, altrimenti null. */
  sourceRepo: string | null;
  sourceBranch: string | null;
  /** L'app espone un contratto OpenAPI raggiungibile (calcolato dal server MCP; qui sempre false). */
  hasOpenApi: boolean;
}

export interface LocalAnalysisSummary {
  analysisId: number;
  appId: number;
  appName: string;
  status: Analysis["status"];
  phase: string | null;
  deliveredPhases: PhaseName[];
  leaseLabel: string | null;
  leaseUntil: Date | null;
}

export type SubmitOutcome =
  | { ok: true; nextPhase: PhaseName | null; summary?: Record<AnalysisChapter, number> }
  | { ok: false; issues: string[] };

// --- Commit atteso ------------------------------------------------------------------------------

// Commit del branch dell'app che l'analisi dovrebbe leggere, per analisi: lo imposta chi lo conosce
// (il server MCP, che lo legge da GitHub al claim). Solo in memoria: dopo un riavvio manca e il
// confronto semplicemente non avviene.
const expectedCommits = new Map<number, string>();

/** Imposta (o con null rimuove) il commit atteso di un'analisi locale. */
export function setExpectedCommit(analysisId: number, commit: string | null): void {
  if (commit && COMMIT_RE.test(commit)) expectedCommits.set(analysisId, commit);
  else expectedCommits.delete(analysisId);
}

/** Commit uguali se uno è il prefisso dell'altro (abbreviato o completo), senza badare alle maiuscole. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

// --- Utilità ------------------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const ROME_TIME = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" });

function logEntry(now: Date, phase: string, message: string) {
  return { at: now.toISOString(), phase, message };
}

const leaseCleared = { leaseTokenHash: null, leaseUntil: null, leaseLabel: null } as const;

function appCard(app: App): LocalAppCard {
  const github = app.sourceType === "github";
  return {
    name: app.name,
    functionalDescription: app.functionalDescription,
    baseUrl: app.baseUrl,
    sourceRepo: github ? app.sourceRepo : null,
    sourceBranch: github ? app.sourceBranch : null,
    hasOpenApi: false,
  };
}

/** Esiti consegnati di un'analisi, nell'ordine delle fasi (non di consegna). */
async function deliveredResults(analysisId: number, executor: Tx | typeof db = db) {
  const rows = await executor
    .select({ phase: analysisPhaseResultsTable.phase, result: analysisPhaseResultsTable.result })
    .from(analysisPhaseResultsTable)
    .where(eq(analysisPhaseResultsTable.analysisId, analysisId));
  const byPhase = new Map(rows.map((r) => [r.phase, r.result]));
  return PHASES.filter((p) => byPhase.has(p)).map((phase) => ({ phase, result: byPhase.get(phase) }));
}

/** Riga dell'analisi locale bloccata per la transazione; null se non esiste o non è locale. */
async function lockLocal(tx: Tx, analysisId: number): Promise<Analysis | null> {
  const [row] = await tx
    .select()
    .from(analysesTable)
    .where(and(eq(analysesTable.id, analysisId), eq(analysesTable.executor, "local")))
    .for("update");
  return row ?? null;
}

/**
 * Analisi con la lease valida per questo token, altrimenti l'errore per l'agente: inesistente o non
 * locale → non trovata; chiusa, token diverso o lease scaduta → lease scaduta.
 */
function requireLease(row: Analysis | null | undefined, leaseToken: string, now: Date): Analysis {
  if (!row) throw new LocalAnalysisError(LOCAL_MESSAGES.notFound);
  const valid =
    row.status === "running" &&
    row.leaseTokenHash !== null &&
    row.leaseTokenHash === hashToken(leaseToken) &&
    row.leaseUntil !== null &&
    row.leaseUntil.getTime() > now.getTime();
  if (!valid) throw new LocalAnalysisError(LOCAL_MESSAGES.leaseExpired);
  return row;
}

function currentPhase(row: Analysis): PhaseName {
  const phase = row.phase as PhaseName | null;
  if (!phase || !PHASES.includes(phase)) throw new LocalAnalysisError(LOCAL_MESSAGES.leaseExpired);
  return phase;
}

// --- Elenco e presa in carico -------------------------------------------------------------------

/** Analisi locali in coda o in corso, con le fasi già consegnate. */
export async function listOpenLocalAnalyses(): Promise<LocalAnalysisSummary[]> {
  const rows = await db
    .select({ analysis: analysesTable, appName: appsTable.name })
    .from(analysesTable)
    .innerJoin(appsTable, eq(appsTable.id, analysesTable.appId))
    .where(and(eq(analysesTable.executor, "local"), inArray(analysesTable.status, ["queued", "running"])))
    .orderBy(analysesTable.createdAt, analysesTable.id);
  if (rows.length === 0) return [];
  const delivered = await db
    .select({ analysisId: analysisPhaseResultsTable.analysisId, phase: analysisPhaseResultsTable.phase })
    .from(analysisPhaseResultsTable)
    .where(inArray(analysisPhaseResultsTable.analysisId, rows.map((r) => r.analysis.id)));
  return rows.map(({ analysis, appName }) => {
    const phases = new Set(delivered.filter((d) => d.analysisId === analysis.id).map((d) => d.phase));
    return {
      analysisId: analysis.id,
      appId: analysis.appId,
      appName,
      status: analysis.status,
      phase: analysis.phase,
      deliveredPhases: PHASES.filter((p) => phases.has(p)),
      leaseLabel: analysis.leaseLabel,
      leaseUntil: analysis.leaseUntil,
    };
  });
}

/**
 * Prende in carico un'analisi locale: atomica (riga bloccata nella transazione), riesce solo se
 * l'analisi è in coda o la lease precedente è scaduta. Riparte dalla prima fase senza esito.
 */
export async function claimLocalAnalysis(
  analysisId: number,
  label: string,
  now: Date = new Date(),
): Promise<{ leaseToken: string; phase: PhaseName; app: LocalAppCard }> {
  const cleanLabel = label.trim();
  if (cleanLabel.length === 0 || cleanLabel.length > LABEL_MAX_CHARS) throw new LocalAnalysisError(LOCAL_MESSAGES.invalidLabel);

  const leaseToken = randomBytes(32).toString("base64url");
  const result = await db.transaction(async (tx) => {
    const row = await lockLocal(tx, analysisId);
    if (!row || (row.status !== "queued" && row.status !== "running")) throw new LocalAnalysisError(LOCAL_MESSAGES.notFound);
    if (row.status === "running" && row.leaseUntil && row.leaseUntil.getTime() > now.getTime()) {
      throw new LocalAnalysisError(`analisi già presa da ${row.leaseLabel ?? "un altro agente"} fino alle ${ROME_TIME.format(row.leaseUntil)}`);
    }
    const [app] = await tx.select().from(appsTable).where(eq(appsTable.id, row.appId)).limit(1);
    if (!app) throw new LocalAnalysisError(LOCAL_MESSAGES.notFound);
    const done = new Set((await deliveredResults(analysisId, tx)).map((d) => d.phase));
    const phase = PHASES.find((p) => !done.has(p));
    // Tutte le fasi consegnate ma analisi aperta: non dovrebbe succedere (l'ultima consegna la chiude)
    if (!phase) throw new LocalAnalysisError(LOCAL_MESSAGES.notFound);

    // Condizionata anche nella WHERE: in coda, oppure in corso con la lease scaduta
    const [updated] = await tx
      .update(analysesTable)
      .set({
        status: "running",
        phase,
        leaseTokenHash: hashToken(leaseToken),
        leaseUntil: new Date(now.getTime() + LOCAL_LEASE_MS),
        leaseLabel: cleanLabel,
        log: appendLog(row.log ?? [], [logEntry(now, phase, `fase ${phase} presa in carico dall'agente locale`)]),
      })
      .where(
        and(
          eq(analysesTable.id, analysisId),
          or(
            eq(analysesTable.status, "queued"),
            and(eq(analysesTable.status, "running"), or(sql`${analysesTable.leaseUntil} is null`, lt(analysesTable.leaseUntil, now))),
          ),
        ),
      )
      .returning({ id: analysesTable.id });
    if (!updated) throw new LocalAnalysisError(LOCAL_MESSAGES.notFound);
    return { phase, app: appCard(app) };
  });
  logger.info({ analysisId, phase: result.phase }, "Analisi locale presa in carico");
  return { leaseToken, ...result };
}

// --- Istruzioni e consegna ----------------------------------------------------------------------

/** Istruzioni della fase corrente: premessa locale + prompt di sistema, e il prompt della fase. */
export async function localPhaseInstructions(
  analysisId: number,
  leaseToken: string,
  now: Date = new Date(),
): Promise<{ phase: PhaseName; system: string; user: string }> {
  const [row] = await db
    .select()
    .from(analysesTable)
    .where(and(eq(analysesTable.id, analysisId), eq(analysesTable.executor, "local")))
    .limit(1);
  const analysis = requireLease(row, leaseToken, now);
  const phase = currentPhase(analysis);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, analysis.appId)).limit(1);
  if (!app) throw new LocalAnalysisError(LOCAL_MESSAGES.notFound);
  const card = appCard(app);
  const previous: Partial<Record<PhaseName, unknown>> = {};
  for (const d of await deliveredResults(analysisId)) previous[d.phase] = d.result;
  const user = phasePrompt(phase, {
    appName: card.name,
    baseUrl: card.baseUrl,
    functionalDescription: card.functionalDescription,
    hasCode: true,
    hasOpenApi: card.hasOpenApi,
    // Casello non scarica il codice: la mappa del repository la costruisce l'agente sul suo clone
    repoMap: "",
    previous,
  });
  return { phase, system: `${LOCAL_PREFACE}\n\n${SYSTEM_BASE}`, user };
}

/** Elementi della proposta per capitolo, tutti i capitoli presenti (anche a zero). */
async function chapterCounts(tx: Tx, analysisId: number): Promise<Record<AnalysisChapter, number>> {
  const rows = await tx
    .select({ chapter: analysisItemsTable.chapter, n: count() })
    .from(analysisItemsTable)
    .where(eq(analysisItemsTable.analysisId, analysisId))
    .groupBy(analysisItemsTable.chapter);
  const summary: Record<AnalysisChapter, number> = { tool: 0, endpoint: 0, agent: 0, skill: 0, completion: 0, evolution: 0 };
  for (const r of rows) summary[r.chapter] = Number(r.n);
  return summary;
}

/**
 * Consegna l'esito della fase corrente. In un'unica transazione con la riga dell'analisi bloccata:
 * controllo di lease e fase, validazione, esito salvato, elementi della proposta registrati, fase
 * successiva e lease rinnovata; dopo `evolution` l'analisi è completata. Un esito non valido torna
 * con le issues e non cambia nulla.
 */
export async function submitLocalPhase(
  analysisId: number,
  leaseToken: string,
  phase: PhaseName,
  result: unknown,
  sourceCommit?: string,
  now: Date = new Date(),
): Promise<SubmitOutcome> {
  const commit = typeof sourceCommit === "string" && COMMIT_RE.test(sourceCommit) ? sourceCommit : null;
  const outcome = await db.transaction(async (tx): Promise<SubmitOutcome & { inserted?: number }> => {
    const analysis = requireLease(await lockLocal(tx, analysisId), leaseToken, now);
    const expected = currentPhase(analysis);
    if (phase !== expected) throw new LocalAnalysisError(`fase attesa: ${expected}`);

    const parsed = PHASE_SCHEMAS[phase].safeParse(result);
    if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error.issues) };
    const data: unknown = parsed.data;

    await tx.insert(analysisPhaseResultsTable).values({ analysisId, phase, result: data, submittedAt: now });
    const inserted = await recordPhaseResult({ analysisId, appId: analysis.appId, phase, result: data }, tx);

    const entries = [logEntry(now, phase, `fase ${phase} consegnata dall'agente locale${inserted ? ` (${inserted} elementi)` : ""}`)];
    const expectedCommit = expectedCommits.get(analysisId) ?? null;
    if (commit && expectedCommit && !sameCommit(commit, expectedCommit)) {
      entries.push(logEntry(now, phase, `analizzato il commit ${commit}, atteso ${expectedCommit}`));
    }

    const nextPhase = PHASES[PHASES.indexOf(phase) + 1] ?? null;
    const changes: Partial<typeof analysesTable.$inferInsert> = {
      log: appendLog(analysis.log ?? [], entries),
      ...(commit ? { sourceCommit: commit } : {}),
      ...(phase === "map" ? { architectureMap: { ...(data as object) } } : {}),
    };
    if (nextPhase) {
      Object.assign(changes, { phase: nextPhase, leaseUntil: new Date(now.getTime() + LOCAL_LEASE_MS) });
    } else {
      Object.assign(changes, { status: "completed", finishedAt: now, ...leaseCleared });
    }
    await tx.update(analysesTable).set(changes).where(eq(analysesTable.id, analysisId));
    if (nextPhase) return { ok: true, nextPhase, inserted };
    return { ok: true, nextPhase: null, summary: await chapterCounts(tx, analysisId), inserted };
  });

  if (!outcome.ok) {
    logger.info({ analysisId, phase, issues: outcome.issues.length }, "Esito della fase locale non valido");
    return outcome;
  }
  const { inserted, ...rest } = outcome;
  logger.info({ analysisId, phase, inserted, completed: rest.nextPhase === null }, "Fase dell'analisi locale consegnata");
  if (rest.nextPhase === null) expectedCommits.delete(analysisId);
  return rest;
}

// --- Lease: rinnovo, abbandono, rilascio, annullamento, scadenza ---------------------------------

/** Rinnova la lease (l'agente lavora ancora sulla fase). */
export async function pingLocalAnalysis(analysisId: number, leaseToken: string, now: Date = new Date()): Promise<{ leaseUntil: Date }> {
  return db.transaction(async (tx) => {
    requireLease(await lockLocal(tx, analysisId), leaseToken, now);
    const leaseUntil = new Date(now.getTime() + LOCAL_LEASE_MS);
    await tx.update(analysesTable).set({ leaseUntil }).where(eq(analysesTable.id, analysisId));
    return { leaseUntil };
  });
}

/** L'agente rinuncia: l'analisi si chiude come fallita con il suo motivo. */
export async function abandonLocalAnalysis(analysisId: number, leaseToken: string, reason: string, now: Date = new Date()): Promise<void> {
  const cleanReason = reason.trim();
  if (cleanReason.length === 0 || cleanReason.length > REASON_MAX_CHARS) throw new LocalAnalysisError(LOCAL_MESSAGES.invalidReason);
  await db.transaction(async (tx) => {
    const analysis = requireLease(await lockLocal(tx, analysisId), leaseToken, now);
    await tx
      .update(analysesTable)
      .set({
        status: "failed",
        error: `abbandonata dall'agente locale: ${cleanReason}`,
        finishedAt: now,
        log: appendLog(analysis.log ?? [], [logEntry(now, analysis.phase ?? "agente locale", "analisi abbandonata dall'agente locale")]),
        ...leaseCleared,
      })
      .where(eq(analysesTable.id, analysisId));
  });
  expectedCommits.delete(analysisId);
  logger.info({ analysisId }, "Analisi locale abbandonata dall'agente");
}

const openLocal = (analysisId: number) =>
  and(eq(analysesTable.id, analysisId), eq(analysesTable.executor, "local"), inArray(analysesTable.status, ["queued", "running"]));

/** Console "Rilascia": lease azzerata, analisi di nuovo in coda. Null se non è un'analisi locale aperta. */
export async function releaseLocalAnalysis(analysisId: number): Promise<Analysis | null> {
  const [row] = await db
    .update(analysesTable)
    .set({ status: "queued", ...leaseCleared })
    .where(openLocal(analysisId))
    .returning();
  return row ?? null;
}

/** Console "Annulla": analisi chiusa come fallita. Null se non è un'analisi locale aperta. */
export async function cancelLocalAnalysis(analysisId: number): Promise<Analysis | null> {
  const [row] = await db
    .update(analysesTable)
    .set({ status: "failed", error: "annullata dalla console", finishedAt: new Date(), ...leaseCleared })
    .where(openLocal(analysisId))
    .returning();
  if (row) expectedCommits.delete(analysisId);
  return row ?? null;
}

/** Le analisi locali in corso con la lease scaduta tornano in coda. Restituisce quante. */
export async function releaseExpiredLeases(now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(analysesTable)
    .set({ status: "queued", ...leaseCleared })
    .where(and(eq(analysesTable.executor, "local"), eq(analysesTable.status, "running"), lt(analysesTable.leaseUntil, now)))
    .returning({ id: analysesTable.id });
  return rows.length;
}

/** Job delle lease scadute: ogni minuto; il timer non tiene in vita il processo. */
export function startLocalLeaseJob(): void {
  setInterval(() => {
    releaseExpiredLeases()
      .then((n) => {
        if (n > 0) logger.info({ count: n }, "Analisi locali con la lease scaduta rimesse in coda");
      })
      .catch((err: unknown) =>
        logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Rilascio delle lease scadute non riuscito"),
      );
  }, LOCAL_LEASE_JOB_MS).unref();
}
