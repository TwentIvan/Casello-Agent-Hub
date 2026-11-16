// Servizio del ciclo di evoluzione automatica (3a): impostazioni e consenso, avvio di un giro con i controlli della spec §5,
// avanzamento del giro alla fine dell'analisi (approvazione delle voci scelte, issue), Ferma, Riprendi ed elimina.
// Ogni passaggio di stato è un UPDATE condizionato: le funzioni sono idempotenti. Chi paga è sempre `activated_by`.
// Nei log solo id, conteggi ed esiti, mai titoli, note o testo delle voci.

import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  db,
  analysesTable,
  analysisItemsTable,
  appArchitectureTable,
  appsTable,
  evolutionCyclesTable,
  evolutionRoundsTable,
  teamTemplatesTable,
  type EvolutionCycle,
  type EvolutionRound,
} from "@workspace/db";
import { ModelChoiceError, MODEL_UNAVAILABLE, chooseCloudModel, type ModelChoice } from "../ai/choice";
import { abortAnalysis } from "../architect/abort";
import { EVOLUTION_ANALYSIS_LIMITS, startAnalysis } from "../architect/run-analysis";
import { requestArchitectureRefresh } from "../architecture/service";
import { userBudgetBlock } from "../budget";
import { userHasInstallation } from "../github/installations";
import { logger } from "../logger";
import { isUniqueViolation } from "../pg-errors";
import { createPlanIssues } from "../plan-issues/service";
import { CONSENT_VERSION, consentHash, consentRequired, type ConsentSettings } from "./consent";
import { EVOLUTION_MESSAGES, roundOutcome } from "./messages";
import { selectRoundItems } from "./select";
import { cycleBudgetBlock } from "./spend";
import { FREQUENCY_MS, backoffMs, nextRoundAt, type EvolutionFrequency } from "./timing";

/** Errore con lo stato HTTP e un messaggio fisso. */
export class EvolutionError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "EvolutionError";
  }
}

export type CycleInput = ConsentSettings & {
  frequency: EvolutionFrequency;
  stagingUrl: string | null;
  consent?: { accepted: true; appSlug: string; version: string; directMerge?: boolean };
};

/** Errori di fila dopo cui il ciclo va in pausa. */
export const MAX_CONSECUTIVE_ERRORS = 5;
const OUTCOME_MAX = 300;
const ROUNDS_LISTED = 20;
const OPEN_STATUSES = ["analyzing", "approving", "implementing", "awaiting_release"] as const;

// --- Lavoro in background (fine delle analisi), atteso dai test ---

const background = new Set<Promise<unknown>>();

export function trackBackground<T>(p: Promise<T>): Promise<T> {
  const tracked = p.finally(() => background.delete(tracked));
  background.add(tracked);
  return p;
}

/** Solo per i test: attende il lavoro avviato in background. */
export async function waitEvolutionIdleForTests(): Promise<void> {
  while (background.size > 0) await Promise.allSettled([...background]);
}

// --- Letture ---

export async function getCycle(appId: number): Promise<EvolutionCycle | null> {
  const [row] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.appId, appId)).limit(1);
  return row ?? null;
}

async function requireCycle(appId: number): Promise<EvolutionCycle> {
  const cycle = await getCycle(appId);
  if (!cycle) throw new EvolutionError(404, EVOLUTION_MESSAGES.notFound);
  return cycle;
}

/** Ultimi 20 giri del ciclo dell'App, dal più recente. */
export async function listRounds(appId: number): Promise<EvolutionRound[]> {
  return db
    .select({ round: evolutionRoundsTable })
    .from(evolutionRoundsTable)
    .innerJoin(evolutionCyclesTable, eq(evolutionCyclesTable.id, evolutionRoundsTable.cycleId))
    .where(eq(evolutionCyclesTable.appId, appId))
    .orderBy(desc(evolutionRoundsTable.number))
    .limit(ROUNDS_LISTED)
    .then((rows) => rows.map((r) => r.round));
}

async function hasOpenRound(cycleId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .where(and(eq(evolutionRoundsTable.cycleId, cycleId), inArray(evolutionRoundsTable.status, [...OPEN_STATUSES])))
    .limit(1);
  return !!row;
}

// --- Consenso ---

/** Impostazioni del ciclo coperte dal consenso; null senza modello dell'analisi (eliminato). */
function settingsOf(cycle: EvolutionCycle): ConsentSettings | null {
  if (cycle.analysisAiModelId === null) return null;
  return {
    mergeMode: cycle.mergeMode,
    stagingBranch: cycle.stagingBranch,
    teamTemplateId: cycle.teamTemplateId,
    analysisAiModelId: cycle.analysisAiModelId,
    itemsPerRound: cycle.itemsPerRound,
    monthlyBudgetUsd: Number(cycle.monthlyBudgetUsd),
  };
}

/**
 * Consenso valido: dato da un utente ancora presente, con l'impronta delle impostazioni attuali. L'impronta contiene
 * CONSENT_VERSION: una versione nuova del testo invalida i consensi precedenti.
 */
function consentValid(cycle: EvolutionCycle): boolean {
  const settings = settingsOf(cycle);
  return (
    cycle.consentAt !== null &&
    cycle.activatedBy !== null &&
    cycle.consentVersion === CONSENT_VERSION &&
    settings !== null &&
    cycle.consentHash === consentHash(settings)
  );
}

/** Due decimali, come la colonna `numeric(12,2)`: l'impronta si calcola sul valore che resta salvato. */
function roundBudget(n: number): number {
  return Math.round(n * 100) / 100;
}

function validateInput(input: CycleInput): ConsentSettings {
  if (input.mergeMode === "staging") throw new EvolutionError(400, EVOLUTION_MESSAGES.modeUnavailable);
  if (input.mergeMode !== "direct") throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  if (!Object.hasOwn(FREQUENCY_MS, input.frequency)) throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  if (!Number.isInteger(input.itemsPerRound) || input.itemsPerRound < 1 || input.itemsPerRound > 10) {
    throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  }
  const budget = roundBudget(input.monthlyBudgetUsd);
  if (!Number.isFinite(budget) || budget <= 0 || budget >= 1e10) throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  if (input.teamTemplateId !== null && (!Number.isSafeInteger(input.teamTemplateId) || input.teamTemplateId <= 0)) {
    throw new EvolutionError(400, EVOLUTION_MESSAGES.templateUnavailable);
  }
  // In `direct` niente branch né indirizzo di prova
  return {
    mergeMode: "direct",
    stagingBranch: null,
    teamTemplateId: input.teamTemplateId,
    analysisAiModelId: input.analysisAiModelId,
    itemsPerRound: input.itemsPerRound,
    monthlyBudgetUsd: budget,
  };
}

/**
 * Crea o aggiorna il ciclo dell'App (spec §9). Serve un consenso nuovo per un ciclo nuovo, per un consenso non più
 * valido, se salva un utente diverso da chi l'ha attivato o se cambia un'impostazione dell'impronta (salvo abbassare il
 * tetto: l'impronta si ricalcola col valore nuovo). In 3a si accetta solo `direct` e nulla si unisce, quindi `directMerge`
 * non è richiesto (lo chiede la 3b insieme alla squadra). Un ciclo nuovo nasce attivo e dovuto subito.
 */
export async function saveCycle(appId: number, userId: number, input: CycleInput): Promise<EvolutionCycle> {
  const settings = validateInput(input);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId)).limit(1);
  if (!app) throw new EvolutionError(404, EVOLUTION_MESSAGES.appNotFound);

  const existing = await getCycle(appId);
  const prevSettings = existing && consentValid(existing) ? settingsOf(existing) : null;
  const needsConsent = !existing || prevSettings === null || existing.activatedBy !== userId || consentRequired(prevSettings, settings);
  if (input.consent !== undefined) {
    const c = input.consent;
    if (c.accepted !== true || c.appSlug !== app.slug || c.version !== CONSENT_VERSION) {
      throw new EvolutionError(400, EVOLUTION_MESSAGES.consentInvalid);
    }
  } else if (needsConsent) {
    throw new EvolutionError(400, existing ? EVOLUTION_MESSAGES.consentRenew : EVOLUTION_MESSAGES.consentInvalid);
  }

  // Chi paga (chi salva) deve possedere modello e installazione
  try {
    await chooseCloudModel(settings.analysisAiModelId, userId);
  } catch (err) {
    if (err instanceof ModelChoiceError) throw new EvolutionError(400, err.message);
    throw err;
  }
  if (app.sourceType !== "github" || !app.sourceRepo || app.sourceInstallationId === null) {
    throw new EvolutionError(400, EVOLUTION_MESSAGES.noCode);
  }
  if (!(await userHasInstallation(userId, app.sourceInstallationId))) throw new EvolutionError(400, EVOLUTION_MESSAGES.noAccess);
  if (settings.teamTemplateId !== null) {
    const [template] = await db
      .select({ id: teamTemplatesTable.id })
      .from(teamTemplatesTable)
      .where(and(eq(teamTemplatesTable.id, settings.teamTemplateId), eq(teamTemplatesTable.archived, false)))
      .limit(1);
    if (!template) throw new EvolutionError(400, EVOLUTION_MESSAGES.templateUnavailable);
  }

  const now = new Date();
  const values = {
    frequency: input.frequency,
    itemsPerRound: settings.itemsPerRound,
    analysisAiModelId: settings.analysisAiModelId,
    teamTemplateId: settings.teamTemplateId,
    mergeMode: settings.mergeMode,
    stagingBranch: null,
    stagingUrl: null,
    monthlyBudgetUsd: settings.monthlyBudgetUsd.toFixed(2),
    // Con un consenso nuovo chi salva diventa chi paga; senza (frequenza o tetto più basso) si ricalcola solo l'impronta
    ...(input.consent !== undefined
      ? { activatedBy: userId, consentAt: now, consentVersion: CONSENT_VERSION, consentHash: consentHash(settings) }
      : { consentHash: consentHash(settings) }),
    updatedAt: now,
  };

  if (!existing) {
    try {
      const [row] = await db
        .insert(evolutionCyclesTable)
        .values({ ...values, appId, status: "active", nextRoundAt: now })
        .returning();
      logger.info({ appId, cycleId: row!.id }, "Ciclo di evoluzione creato");
      return row!;
    } catch (err) {
      // Due creazioni insieme: la seconda diventa un aggiornamento
      if (isUniqueViolation(err, "evolution_cycles_app_id_unique")) return saveCycle(appId, userId, input);
      throw err;
    }
  }

  // Frequenza cambiata: il prossimo giro si conta dall'inizio dell'ultimo
  let next: Date | null = existing.nextRoundAt;
  if (input.frequency !== existing.frequency) {
    const [last] = await db
      .select({ startedAt: evolutionRoundsTable.startedAt })
      .from(evolutionRoundsTable)
      .where(eq(evolutionRoundsTable.cycleId, existing.id))
      .orderBy(desc(evolutionRoundsTable.number))
      .limit(1);
    if (last) next = nextRoundAt(last.startedAt, input.frequency);
  }
  const [row] = await db
    .update(evolutionCyclesTable)
    .set({ ...values, nextRoundAt: next })
    .where(eq(evolutionCyclesTable.id, existing.id))
    .returning();
  logger.info({ appId, cycleId: existing.id, consent: input.consent !== undefined }, "Ciclo di evoluzione aggiornato");
  return row!;
}

// --- Pausa ed errori ---

async function pauseCycle(cycleId: number, reason: string): Promise<void> {
  await db
    .update(evolutionCyclesTable)
    .set({ status: "paused", pausedReason: reason, updatedAt: new Date() })
    .where(eq(evolutionCyclesTable.id, cycleId));
  logger.warn({ cycleId, reason }, "Ciclo di evoluzione in pausa");
}

async function pauseAndThrow(cycleId: number, reason: string): Promise<never> {
  await pauseCycle(cycleId, reason);
  throw new EvolutionError(409, reason);
}

/** Errore transitorio: conta, attesa crescente (dagli errori già registrati), pausa al quinto di fila. */
async function recordError(cycleId: number, message: string): Promise<void> {
  const errors = await db.transaction(async (tx) => {
    const [cycle] = await tx
      .select({ errors: evolutionCyclesTable.consecutiveErrors })
      .from(evolutionCyclesTable)
      .where(eq(evolutionCyclesTable.id, cycleId))
      .for("update");
    if (!cycle) return null;
    const now = new Date();
    const count = cycle.errors + 1;
    await tx
      .update(evolutionCyclesTable)
      .set({
        consecutiveErrors: count,
        lastError: message,
        nextAttemptAt: new Date(now.getTime() + backoffMs(cycle.errors)),
        ...(count >= MAX_CONSECUTIVE_ERRORS ? { status: "paused" as const, pausedReason: EVOLUTION_MESSAGES.tooManyErrors } : {}),
        updatedAt: now,
      })
      .where(eq(evolutionCyclesTable.id, cycleId));
    return count;
  });
  if (errors === null) return;
  logger.warn({ cycleId, errors }, "Giro del ciclo di evoluzione non riuscito");
  if (errors >= MAX_CONSECUTIVE_ERRORS) logger.warn({ cycleId }, "Ciclo di evoluzione in pausa: troppi errori di fila");
}

// --- Avvio del giro ---

/**
 * Avvia un giro (spec §5): controlli in ordine (consenso, codice e accesso, sintesi dell'architettura, modello, tetto del
 * ciclo, tetti di modello, account e utente); un controllo duraturo mette in pausa e risponde 409 col motivo, la sintesi
 * mancante la chiede e risponde 409 senza pausa. Poi, con il ciclo bloccato, giro `analyzing` e analisi `queued` in modalità
 * `evolution`; dopo il commit parte l'analisi. Senza `manual` il ciclo deve essere ancora dovuto (lo schedulatore).
 * Un'altra analisi aperta sull'App (es. avviata dall'utente) è transitoria: 409 senza pausa né errore, il giro si riprova
 * al controllo successivo perché `next_round_at` non cambia.
 */
export async function startRound(cycleId: number, opts: { manual?: boolean } = {}): Promise<EvolutionRound> {
  const [cycle] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, cycleId)).limit(1);
  if (!cycle) throw new EvolutionError(404, EVOLUTION_MESSAGES.notFound);
  if (cycle.status !== "active") throw new EvolutionError(409, EVOLUTION_MESSAGES.paused);
  if (await hasOpenRound(cycleId)) throw new EvolutionError(409, EVOLUTION_MESSAGES.roundRunning);

  // 1. Consenso (il modello eliminato si segnala al punto 3)
  if (cycle.analysisAiModelId !== null && !consentValid(cycle)) await pauseAndThrow(cycleId, EVOLUTION_MESSAGES.consentRenew);
  if (cycle.activatedBy === null) await pauseAndThrow(cycleId, EVOLUTION_MESSAGES.consentRenew);
  const payer = cycle.activatedBy!;

  // 2. Codice da GitHub tramite un'installazione di chi paga, poi la sintesi dell'architettura
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, cycle.appId)).limit(1);
  if (!app) throw new EvolutionError(404, EVOLUTION_MESSAGES.appNotFound);
  if (app.sourceType !== "github" || !app.sourceRepo || app.sourceInstallationId === null) {
    await pauseAndThrow(cycleId, EVOLUTION_MESSAGES.noCode);
  }
  if (!(await userHasInstallation(payer, app.sourceInstallationId!))) await pauseAndThrow(cycleId, EVOLUTION_MESSAGES.noAccess);
  const [arch] = await db
    .select({ summary: appArchitectureTable.summary })
    .from(appArchitectureTable)
    .where(eq(appArchitectureTable.appId, app.id))
    .limit(1);
  if (!arch?.summary?.trim()) {
    try {
      await requestArchitectureRefresh(app.id, { bypassOff: true, clearBackoff: false });
    } catch (err) {
      logger.error({ cycleId, errName: err instanceof Error ? err.name : "unknown" }, "Richiesta della sintesi per il ciclo non riuscita");
    }
    throw new EvolutionError(409, EVOLUTION_MESSAGES.waitingArchitecture);
  }

  // 3. Modello dell'analisi, cloud e di chi paga
  if (cycle.analysisAiModelId === null) await pauseAndThrow(cycleId, MODEL_UNAVAILABLE);
  let choice: ModelChoice;
  try {
    choice = await chooseCloudModel(cycle.analysisAiModelId!, payer);
  } catch (err) {
    if (!(err instanceof ModelChoiceError)) throw err;
    return pauseAndThrow(cycleId, err.message);
  }

  // 4. Tetto del ciclo; 5. tetti di modello, account e utente
  const cycleBlock = await cycleBudgetBlock(cycle);
  if (cycleBlock) await pauseAndThrow(cycleId, cycleBlock);
  const userBlock = await userBudgetBlock(choice.aiModelId);
  if (userBlock) await pauseAndThrow(cycleId, userBlock);

  let created: { round: EvolutionRound; analysisId: number };
  try {
    created = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, cycleId)).for("update");
      if (!locked || locked.status !== "active") throw new EvolutionError(409, EVOLUTION_MESSAGES.paused);
      const now = new Date();
      const due =
        locked.nextRoundAt !== null && locked.nextRoundAt <= now && (locked.nextAttemptAt === null || locked.nextAttemptAt <= now);
      if (!opts.manual && !due) throw new EvolutionError(409, EVOLUTION_MESSAGES.roundRunning);
      const [open] = await tx
        .select({ id: evolutionRoundsTable.id })
        .from(evolutionRoundsTable)
        .where(and(eq(evolutionRoundsTable.cycleId, cycleId), inArray(evolutionRoundsTable.status, [...OPEN_STATUSES])))
        .limit(1);
      if (open) throw new EvolutionError(409, EVOLUTION_MESSAGES.roundRunning);
      const [last] = await tx
        .select({ n: max(evolutionRoundsTable.number) })
        .from(evolutionRoundsTable)
        .where(eq(evolutionRoundsTable.cycleId, cycleId));
      const [round] = await tx
        .insert(evolutionRoundsTable)
        .values({ cycleId, number: (last?.n ?? 0) + 1, status: "analyzing", startedAt: now })
        .returning();
      const [analysis] = await tx
        .insert(analysesTable)
        .values({
          appId: app.id,
          model: choice.model,
          aiModelId: choice.aiModelId,
          maxTokens: EVOLUTION_ANALYSIS_LIMITS.maxTokens,
          mode: "evolution",
          evolutionRoundId: round!.id,
          sources: { code: "github", openapi: false, mcp: false, description: !!app.functionalDescription?.trim() },
        })
        .returning({ id: analysesTable.id });
      const [withAnalysis] = await tx
        .update(evolutionRoundsTable)
        .set({ analysisId: analysis!.id })
        .where(eq(evolutionRoundsTable.id, round!.id))
        .returning();
      await tx
        .update(evolutionCyclesTable)
        .set({ nextRoundAt: nextRoundAt(now, locked.frequency), updatedAt: now })
        .where(eq(evolutionCyclesTable.id, cycleId));
      return { round: withAnalysis!, analysisId: analysis!.id };
    });
  } catch (err) {
    if (isUniqueViolation(err, "evolution_rounds_one_open") || isUniqueViolation(err, "evolution_rounds_cycle_id_number_unique")) {
      throw new EvolutionError(409, EVOLUTION_MESSAGES.roundRunning);
    }
    if (isUniqueViolation(err, "analyses_one_active_per_app")) throw new EvolutionError(409, EVOLUTION_MESSAGES.analysisBusy);
    throw err;
  }
  logger.info({ cycleId, roundId: created.round.id, analysisId: created.analysisId, manual: !!opts.manual }, "Giro del ciclo di evoluzione avviato");
  void startAnalysis(created.analysisId);
  return created.round;
}

// --- Avanzamento ---

function truncate(text: string): string {
  return text.length > OUTCOME_MAX ? `${text.slice(0, OUTCOME_MAX - 1)}…` : text;
}

/** Giro `analyzing` → `failed` col messaggio (una volta sola), poi l'errore si conta sul ciclo. */
async function failRound(round: EvolutionRound, message: string): Promise<boolean> {
  const [closed] = await db
    .update(evolutionRoundsTable)
    .set({ status: "failed", outcome: truncate(message), finishedAt: new Date() })
    .where(and(eq(evolutionRoundsTable.id, round.id), eq(evolutionRoundsTable.status, "analyzing")))
    .returning({ id: evolutionRoundsTable.id });
  if (!closed) return false;
  await recordError(round.cycleId, truncate(message));
  return true;
}

/**
 * Fa avanzare un giro `analyzing` la cui analisi è finita. Completata: in una transazione `analyzing` → `approving`,
 * approvazione delle voci scelte (UPDATE condizionato `pending` → `approved`, senza `applyItem`: completamento ed evoluzione
 * non hanno effetti), `done` con l'esito; errori del ciclo azzerati; dopo il commit le issue (un errore non ferma nulla).
 * Fallita, interrotta o sparita: giro `failed` ed errore contato. Un giro in un altro stato (es. `stopped`) non cambia.
 */
export async function advanceRound(roundId: number): Promise<void> {
  const [round] = await db.select().from(evolutionRoundsTable).where(eq(evolutionRoundsTable.id, roundId)).limit(1);
  if (!round || round.status !== "analyzing") return;
  const [analysis] =
    round.analysisId === null
      ? []
      : await db
          .select({ status: analysesTable.status, error: analysesTable.error })
          .from(analysesTable)
          .where(eq(analysesTable.id, round.analysisId))
          .limit(1);
  if (analysis && (analysis.status === "queued" || analysis.status === "running")) return;
  if (!analysis || analysis.status === "interrupted") {
    await failRound(round, EVOLUTION_MESSAGES.restartInterrupted);
    return;
  }
  if (analysis.status === "failed") {
    await failRound(round, analysis.error ?? EVOLUTION_MESSAGES.restartInterrupted);
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [approving] = await tx
      .update(evolutionRoundsTable)
      .set({ status: "approving" })
      .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "analyzing")))
      .returning();
    if (!approving) return null;
    const [cycle] = await tx.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, approving.cycleId));
    const items = await tx.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, round.analysisId!));
    const chosen = selectRoundItems(items, cycle!.itemsPerRound);
    const now = new Date();
    const approved =
      chosen.length === 0
        ? []
        : await tx
            .update(analysisItemsTable)
            .set({ status: "approved", approvedByCycle: true, appliedAt: now })
            .where(and(inArray(analysisItemsTable.id, chosen), eq(analysisItemsTable.status, "pending")))
            .returning({ id: analysisItemsTable.id });
    // Nell'ordine della scelta
    const approvedSet = new Set(approved.map((a) => a.id));
    const ids = chosen.filter((id) => approvedSet.has(id));
    await tx
      .update(evolutionRoundsTable)
      .set({
        status: "done",
        itemIds: ids,
        outcome: ids.length > 0 ? roundOutcome(ids.length) : EVOLUTION_MESSAGES.noNewItems,
        finishedAt: now,
      })
      .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "approving")));
    await tx
      .update(evolutionCyclesTable)
      .set({ consecutiveErrors: 0, lastError: null, nextAttemptAt: null, updatedAt: now })
      .where(eq(evolutionCyclesTable.id, approving.cycleId));
    return { ids, cycle: cycle! };
  });
  if (!result) return;
  logger.info({ cycleId: round.cycleId, roundId, approved: result.ids.length }, "Giro del ciclo di evoluzione concluso");

  if (result.ids.length > 0 && result.cycle.activatedBy !== null) {
    try {
      const { results } = await createPlanIssues(result.cycle.appId, result.cycle.activatedBy, result.ids);
      logger.info({ roundId, created: results.filter((r) => r.outcome === "created").length }, "Issue delle voci del giro");
    } catch (err) {
      // Le voci restano approvate senza issue
      logger.warn({ roundId, errName: err instanceof Error ? err.name : "unknown" }, "Issue delle voci del giro non create");
    }
  }
}

/** Fine di un'analisi: fa avanzare il giro che la aspetta, se c'è. */
export async function handleAnalysisFinished(analysisId: number): Promise<void> {
  const [round] = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .where(and(eq(evolutionRoundsTable.analysisId, analysisId), eq(evolutionRoundsTable.status, "analyzing")))
    .limit(1);
  if (round) await advanceRound(round.id);
}

/**
 * Giri `analyzing` la cui analisi non è più in coda né in corso (riavvio, avviso di fine perso): ognuno avanza come alla
 * fine dell'analisi; un'analisi interrotta o sparita chiude il giro `failed` «giro interrotto dal riavvio» con l'errore
 * contato. Risponde quanti giri sono stati chiusi.
 */
export async function failInterruptedRounds(): Promise<number> {
  const rows = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .leftJoin(analysesTable, eq(analysesTable.id, evolutionRoundsTable.analysisId))
    .where(
      and(
        eq(evolutionRoundsTable.status, "analyzing"),
        sql`(${analysesTable.id} is null or ${analysesTable.status} not in ('queued', 'running'))`,
      ),
    );
  let closed = 0;
  for (const row of rows) {
    await advanceRound(row.id);
    const [after] = await db.select({ status: evolutionRoundsTable.status }).from(evolutionRoundsTable).where(eq(evolutionRoundsTable.id, row.id));
    if (after && after.status !== "analyzing") closed++;
  }
  if (closed > 0) logger.warn({ count: closed }, "Giri del ciclo di evoluzione chiusi dopo il riavvio");
  return closed;
}

// --- Ferma, Riprendi, elimina ---

/**
 * Ferma il ciclo (spec §8): pausa «fermato dall'utente», giro aperto `stopped`, analisi del giro fermata (in questo
 * processo col segnale, altrimenti chiusa nel DB se ancora in coda o in corso).
 */
export async function stopCycle(appId: number): Promise<EvolutionCycle> {
  const cycle = await requireCycle(appId);
  const { updated, analysisIds } = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(evolutionCyclesTable)
      .set({ status: "paused", pausedReason: EVOLUTION_MESSAGES.stoppedByUser, updatedAt: now })
      .where(eq(evolutionCyclesTable.id, cycle.id))
      .returning();
    const stopped = await tx
      .update(evolutionRoundsTable)
      .set({ status: "stopped", outcome: EVOLUTION_MESSAGES.stoppedByUser, finishedAt: now })
      .where(and(eq(evolutionRoundsTable.cycleId, cycle.id), inArray(evolutionRoundsTable.status, [...OPEN_STATUSES])))
      .returning({ analysisId: evolutionRoundsTable.analysisId });
    return { updated: row!, analysisIds: stopped.map((s) => s.analysisId).filter((id): id is number => id !== null) };
  });
  for (const id of analysisIds) {
    if (abortAnalysis(id)) continue;
    await db
      .update(analysesTable)
      .set({ status: "failed", error: EVOLUTION_MESSAGES.analysisStopped, finishedAt: new Date() })
      .where(and(eq(analysesTable.id, id), inArray(analysesTable.status, ["queued", "running"])));
  }
  logger.info({ cycleId: cycle.id, rounds: analysisIds.length }, "Ciclo di evoluzione fermato");
  return updated;
}

/**
 * Riprende il ciclo: serve un consenso valido dato da chi riprende (chi paga resta chi ha acconsentito), altrimenti
 * «consenso da rinnovare». Errori azzerati e giro dovuto subito.
 */
export async function resumeCycle(appId: number, userId: number): Promise<EvolutionCycle> {
  const cycle = await requireCycle(appId);
  if (!consentValid(cycle) || cycle.activatedBy !== userId) throw new EvolutionError(400, EVOLUTION_MESSAGES.consentRenew);
  const now = new Date();
  const [row] = await db
    .update(evolutionCyclesTable)
    .set({
      status: "active",
      pausedReason: null,
      consecutiveErrors: 0,
      lastError: null,
      nextAttemptAt: null,
      nextRoundAt: now,
      updatedAt: now,
    })
    .where(eq(evolutionCyclesTable.id, cycle.id))
    .returning();
  logger.info({ cycleId: cycle.id }, "Ciclo di evoluzione ripreso");
  return row!;
}

/** Elimina il ciclo e i suoi giri; un ciclo attivo o con un giro aperto va prima fermato. */
export async function deleteCycle(appId: number): Promise<void> {
  const cycle = await requireCycle(appId);
  if (cycle.status === "active" || (await hasOpenRound(cycle.id))) throw new EvolutionError(409, EVOLUTION_MESSAGES.stopBeforeDelete);
  await db
    .delete(evolutionCyclesTable)
    .where(and(eq(evolutionCyclesTable.id, cycle.id), eq(evolutionCyclesTable.status, "paused")));
  logger.info({ cycleId: cycle.id }, "Ciclo di evoluzione eliminato");
}
