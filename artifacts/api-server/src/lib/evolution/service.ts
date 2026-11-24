// Servizio del ciclo di evoluzione automatica (3a + 3c): impostazioni e consenso, avvio di un giro con i controlli della spec §5,
// avanzamento del giro alla fine dell'analisi (approvazione delle voci scelte, issue), squadra del ciclo con il messaggio
// «Implementa» e giro che segue il lavoro della squadra (spec §15.8), Ferma, Riprendi ed elimina.
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
  pendingActionsTable,
  teamInstancesTable,
  teamTasksTable,
  teamTemplatesTable,
  teamWorksTable,
  type EvolutionCycle,
  type EvolutionRound,
  type TeamWork,
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
import { itemTitle } from "../plan-chat/context";
import { codeWrites } from "../teams/manifest";
import { InstanceError, createInstance } from "../teams/instances";
import { patchPlan } from "../teams/plan";
import { TeamRuleError } from "../teams/rules";
import { pumpTasks } from "../teams/task-runner";
import { EVOLUTION_REF_TYPE } from "../teams/team-spend";
import { TemplateError, getTemplateVersion } from "../teams/templates";
import { activateInstance } from "../teams/turn-runner";
import { enqueueTurnReason, notifyTurnQueued } from "../teams/turn-queue";
import { getOpenWork } from "../teams/works";
import { CONSENT_VERSION, consentHash, consentRequired, consentValid, settingsOf, type ConsentSettings } from "./consent";
import { cycleEvent } from "./cycle-team";
import { implementMessage } from "./implement";
import { EVOLUTION_MESSAGES, awaitingReleaseOutcome, implementingOutcome, releasedOutcome, roundOutcome } from "./messages";
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
  /** Dalla 3c non decide più nulla: si accetta e si salva sempre `direct`. */
  mergeMode?: "staging" | "direct";
  stagingBranch?: string | null;
  stagingUrl?: string | null;
  consent?: { accepted: true; appSlug: string; version: string; directMerge?: boolean };
};

export { consentValid } from "./consent";

/** Errori di fila dopo cui il ciclo va in pausa. */
export const MAX_CONSECUTIVE_ERRORS = 5;
const OUTCOME_MAX = 300;
const ROUNDS_LISTED = 20;
const OPEN_STATUSES = ["analyzing", "approving", "implementing", "awaiting_release"] as const;
/** Giri che seguono il lavoro della squadra del ciclo (3c): «Ferma» non li chiude, riprendono con «Riprendi». */
const TEAM_STATUSES = ["implementing", "awaiting_release"] as const;
/** Durata massima di un giro in `implementing` (spec §15.8). */
export const IMPLEMENTING_MAX_HOURS = 72;

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

/** Due decimali, come la colonna `numeric(12,2)`: l'impronta si calcola sul valore che resta salvato. */
function roundBudget(n: number): number {
  return Math.round(n * 100) / 100;
}

function validateInput(input: CycleInput): ConsentSettings {
  if (input.mergeMode !== undefined && input.mergeMode !== "direct" && input.mergeMode !== "staging") {
    throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  }
  if (!Object.hasOwn(FREQUENCY_MS, input.frequency)) throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  if (!Number.isInteger(input.itemsPerRound) || input.itemsPerRound < 1 || input.itemsPerRound > 10) {
    throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  }
  const budget = roundBudget(input.monthlyBudgetUsd);
  if (!Number.isFinite(budget) || budget <= 0 || budget >= 1e10) throw new EvolutionError(400, EVOLUTION_MESSAGES.invalidSettings);
  if (input.teamTemplateId !== null && (!Number.isSafeInteger(input.teamTemplateId) || input.teamTemplateId <= 0)) {
    throw new EvolutionError(400, EVOLUTION_MESSAGES.templateUnavailable);
  }
  return {
    teamTemplateId: input.teamTemplateId,
    analysisAiModelId: input.analysisAiModelId,
    itemsPerRound: input.itemsPerRound,
    monthlyBudgetUsd: budget,
  };
}

/**
 * Crea o aggiorna il ciclo dell'App (spec §9). Serve un consenso nuovo per un ciclo nuovo, per un consenso non più
 * valido, se salva un utente diverso da chi l'ha attivato o se cambia un'impostazione dell'impronta (salvo abbassare il
 * tetto: l'impronta si ricalcola col valore nuovo). `merge_mode` non decide più nulla (3c): si salva `direct`. Il modello di
 * squadra deve avere un ruolo che scrive codice. Un ciclo nuovo nasce attivo e dovuto subito; il tetto si copia sulla squadra.
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
    const [row] = await db.select({ version: teamTemplatesTable.version }).from(teamTemplatesTable).where(eq(teamTemplatesTable.id, template.id)).limit(1);
    const roles = await getTemplateVersion(template.id, row!.version);
    if (!roles.some((r) => codeWrites(r.code ?? "none"))) throw new EvolutionError(400, EVOLUTION_MESSAGES.templateNoCode);
  }

  const now = new Date();
  const values = {
    frequency: input.frequency,
    itemsPerRound: settings.itemsPerRound,
    analysisAiModelId: settings.analysisAiModelId,
    teamTemplateId: settings.teamTemplateId,
    mergeMode: "direct" as const,
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
  // La squadra del ciclo usa il tetto del ciclo: la colonna della squadra si allinea per la console
  if (row!.teamInstanceId !== null) {
    await db
      .update(teamInstancesTable)
      .set({ monthlyBudgetUsd: values.monthlyBudgetUsd, updatedAt: now })
      .where(and(eq(teamInstancesTable.id, row!.teamInstanceId), inArray(teamInstancesTable.status, ["draft", "active"])));
  }
  logger.info({ appId, cycleId: existing.id, consent: input.consent !== undefined }, "Ciclo di evoluzione aggiornato");
  return row!;
}

// --- Pausa ed errori ---

async function pauseCycle(cycleId: number, reason: string): Promise<void> {
  const rows = await db
    .update(evolutionCyclesTable)
    .set({ status: "paused", pausedReason: reason, updatedAt: new Date() })
    // Solo un ciclo ancora attivo: una lettura vecchia non sovrascrive «fermato dall'utente» né rimette in pausa un ciclo appena ripreso
    .where(and(eq(evolutionCyclesTable.id, cycleId), eq(evolutionCyclesTable.status, "active")))
    .returning({ id: evolutionCyclesTable.id });
  if (rows.length > 0) {
    logger.warn({ cycleId, reason }, "Ciclo di evoluzione in pausa");
    const [cycle] = await db.select({ teamInstanceId: evolutionCyclesTable.teamInstanceId }).from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, cycleId)).limit(1);
    if (cycle) await cycleEvent(cycle, `Ciclo di evoluzione in pausa: ${reason}`);
  }
}

async function pauseAndThrow(cycleId: number, reason: string): Promise<never> {
  await pauseCycle(cycleId, reason);
  throw new EvolutionError(409, reason);
}

/** Errore transitorio: conta, attesa crescente (dagli errori già registrati), pausa al quinto di fila. */
async function recordError(cycleId: number, message: string): Promise<void> {
  const errors = await db.transaction(async (tx) => {
    const [cycle] = await tx
      .select({ errors: evolutionCyclesTable.consecutiveErrors, status: evolutionCyclesTable.status })
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
        // Il nuovo tentativo lo decide l'attesa, non la frequenza: il giro fallito è già dovuto
        nextRoundAt: now,
        ...(count >= MAX_CONSECUTIVE_ERRORS && cycle.status === "active" ? { status: "paused" as const, pausedReason: EVOLUTION_MESSAGES.tooManyErrors } : {}),
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
  // Nessun giro nuovo finché il lavoro della squadra del ciclo non è chiuso (transitorio: niente pausa né errore)
  if (cycle.teamInstanceId !== null && (await getOpenWork(cycle.teamInstanceId))) throw new EvolutionError(409, EVOLUTION_MESSAGES.workOpen);

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
    // Prima la riga del ciclo, poi il giro: lo stesso ordine di lock di «Ferma»
    const [cycle] = await tx.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, round.cycleId)).for("update");
    if (!cycle) return null;
    // Ciclo messo in pausa o consenso non più valido durante l'analisi: il giro si chiude senza approvare nulla
    const blocked = cycle.status !== "active" ? (cycle.pausedReason ?? EVOLUTION_MESSAGES.paused) : !consentValid(cycle) ? EVOLUTION_MESSAGES.consentRenew : null;
    if (blocked !== null) {
      const now = new Date();
      const [closed] = await tx
        .update(evolutionRoundsTable)
        .set({ status: "stopped", outcome: truncate(blocked), finishedAt: now })
        .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "analyzing")))
        .returning({ id: evolutionRoundsTable.id });
      if (closed && cycle.status === "active") {
        await tx
          .update(evolutionCyclesTable)
          .set({ status: "paused", pausedReason: EVOLUTION_MESSAGES.consentRenew, updatedAt: now })
          .where(eq(evolutionCyclesTable.id, cycle.id));
      }
      return closed ? { ids: [] as number[], cycle, blocked, withTeam: false } : null;
    }
    const [approving] = await tx
      .update(evolutionRoundsTable)
      .set({ status: "approving" })
      .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "analyzing")))
      .returning();
    if (!approving) return null;
    const items = await tx.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, round.analysisId!));
    const chosen = selectRoundItems(items, cycle.itemsPerRound);
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
    // 3c: con un modello di squadra le voci vanno alla squadra del ciclo e il giro segue il suo lavoro
    const withTeam = cycle.teamTemplateId !== null && ids.length > 0;
    await tx
      .update(evolutionRoundsTable)
      .set({
        status: withTeam ? "implementing" : "done",
        itemIds: ids,
        outcome: ids.length === 0 ? EVOLUTION_MESSAGES.noNewItems : withTeam ? implementingOutcome(ids.length) : roundOutcome(ids.length),
        finishedAt: withTeam ? null : now,
      })
      .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "approving")));
    await tx
      .update(evolutionCyclesTable)
      .set({ consecutiveErrors: 0, lastError: null, nextAttemptAt: null, updatedAt: now })
      .where(eq(evolutionCyclesTable.id, approving.cycleId));
    return { ids, cycle, blocked: null, withTeam };
  });
  if (!result) return;
  if (result.blocked !== null) {
    logger.info({ cycleId: round.cycleId, roundId }, "Giro del ciclo di evoluzione chiuso senza approvazioni: ciclo in pausa o consenso da rinnovare");
    return;
  }
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
  if (result.withTeam) await startImplementation(roundId);
}

// --- Squadra del ciclo e implementazione (3c) ---

type TeamResult = { id: number; activate: boolean };

/**
 * Squadra del ciclo: quella salvata se non è chiusa e viene dallo stesso modello (passata a chi paga se è cambiato, tetto
 * allineato), altrimenti una nuova in bozza dal modello con `ref` `{type: "evoluzione"}`. `activate` = va attivata dopo aver
 * accodato il messaggio. Errori di regola (ruoli non più validi, modello archiviato) risalgono al chiamante.
 */
async function ensureCycleTeam(cycle: EvolutionCycle, app: { id: number; name: string }): Promise<TeamResult> {
  const payer = cycle.activatedBy!;
  const budget = Number(cycle.monthlyBudgetUsd).toFixed(2);
  if (cycle.teamInstanceId !== null) {
    const [team] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, cycle.teamInstanceId)).limit(1);
    if (team && team.status !== "closed" && team.templateId === cycle.teamTemplateId) {
      await db
        .update(teamInstancesTable)
        .set({ monthlyBudgetUsd: budget, ...(team.status === "active" && team.activatedBy !== payer ? { activatedBy: payer } : {}), updatedAt: new Date() })
        .where(eq(teamInstancesTable.id, team.id));
      return { id: team.id, activate: team.status === "draft" };
    }
  }
  const title = `Evoluzione di ${app.name}`.slice(0, 200);
  const view = await createInstance(payer, {
    templateId: cycle.teamTemplateId!,
    name: title,
    ref: { appId: app.id, type: EVOLUTION_REF_TYPE, id: String(app.id), title },
  });
  await db.update(teamInstancesTable).set({ monthlyBudgetUsd: budget }).where(eq(teamInstancesTable.id, view.id));
  await db.update(evolutionCyclesTable).set({ teamInstanceId: view.id, updatedAt: new Date() }).where(eq(evolutionCyclesTable.id, cycle.id));
  logger.info({ cycleId: cycle.id, instanceId: view.id }, "Squadra del ciclo di evoluzione creata");
  return { id: view.id, activate: true };
}

function ruleMessage(err: unknown): string | null {
  if (err instanceof TeamRuleError || err instanceof TemplateError || err instanceof InstanceError) return err.message;
  return null;
}

/**
 * Affida le voci di un giro `implementing` alla squadra del ciclo: squadra (creata o riusata), poi in una transazione il giro
 * registra squadra e istante del messaggio (orologio del DB, una volta sola) e il capo riceve «Implementa» con le voci;
 * infine la squadra nuova si attiva (il messaggio si aggiunge al turno di attivazione). Con il ciclo in pausa non fa nulla
 * (riprova il controllo periodico). Un errore di regola nella squadra chiude il giro `blocked` e mette in pausa il ciclo.
 */
export async function startImplementation(roundId: number): Promise<void> {
  const [round] = await db.select().from(evolutionRoundsTable).where(eq(evolutionRoundsTable.id, roundId)).limit(1);
  if (!round || round.status !== "implementing" || round.implementationStartedAt !== null) return;
  const [cycle] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, round.cycleId)).limit(1);
  if (!cycle || cycle.status !== "active" || cycle.activatedBy === null || cycle.teamTemplateId === null) return;
  const [app] = await db.select({ id: appsTable.id, name: appsTable.name }).from(appsTable).where(eq(appsTable.id, cycle.appId)).limit(1);
  if (!app) return;

  let team: TeamResult;
  try {
    team = await ensureCycleTeam(cycle, app);
  } catch (err) {
    const msg = ruleMessage(err);
    if (msg === null) throw err;
    const [closed] = await db
      .update(evolutionRoundsTable)
      .set({ status: "blocked", outcome: truncate(msg), finishedAt: new Date() })
      .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "implementing")))
      .returning({ id: evolutionRoundsTable.id });
    if (closed) await pauseCycle(cycle.id, truncate(msg));
    logger.warn({ cycleId: cycle.id, roundId }, "Squadra del ciclo non disponibile");
    return;
  }

  const items = round.itemIds.length === 0
    ? []
    : await db
        .select({ id: analysisItemsTable.id, chapter: analysisItemsTable.chapter, payload: analysisItemsTable.payload, issueNumber: analysisItemsTable.issueNumber })
        .from(analysisItemsTable)
        .where(inArray(analysisItemsTable.id, round.itemIds));
  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = round.itemIds
    .map((id) => byId.get(id))
    .filter((i): i is NonNullable<typeof i> => i !== undefined)
    .map((i) => ({ id: i.id, title: itemTitle(i.chapter as Parameters<typeof itemTitle>[0], i.payload), issueNumber: i.issueNumber }));
  const text = implementMessage(app.name, ordered, round.number);

  const sent = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(evolutionRoundsTable)
      .set({ teamInstanceId: team.id, implementationStartedAt: sql`now()` })
      .where(and(eq(evolutionRoundsTable.id, roundId), eq(evolutionRoundsTable.status, "implementing"), sql`${evolutionRoundsTable.implementationStartedAt} is null`))
      .returning({ id: evolutionRoundsTable.id });
    if (!updated) return false;
    await enqueueTurnReason(team.id, { type: "request", text, source: "system" }, tx);
    await cycleEvent({ teamInstanceId: team.id }, `Giro ${round.number} del ciclo di evoluzione: ${implementingOutcome(ordered.length)}.`, tx);
    return true;
  });
  if (!sent) return;
  if (team.activate) {
    try {
      await activateInstance(cycle.activatedBy, team.id);
    } catch (err) {
      // Già attiva (corsa con un altro processo): il turno parte comunque
      logger.warn({ cycleId: cycle.id, instanceId: team.id, errName: err instanceof Error ? err.name : "unknown" }, "Attivazione della squadra del ciclo non riuscita");
      notifyTurnQueued(team.id);
    }
  } else {
    notifyTurnQueued(team.id);
  }
  logger.info({ cycleId: cycle.id, roundId, instanceId: team.id, items: ordered.length }, "Voci del giro affidate alla squadra del ciclo");
}

async function closeTeamRound(round: EvolutionRound, status: "done" | "blocked", outcome: string): Promise<boolean> {
  const [closed] = await db
    .update(evolutionRoundsTable)
    .set({ status, outcome: truncate(outcome), finishedAt: new Date() })
    .where(and(eq(evolutionRoundsTable.id, round.id), inArray(evolutionRoundsTable.status, [...TEAM_STATUSES])))
    .returning({ id: evolutionRoundsTable.id });
  if (!closed) return false;
  const [cycle] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, round.cycleId)).limit(1);
  if (cycle) {
    if (status === "done") {
      await db
        .update(evolutionCyclesTable)
        .set({ consecutiveErrors: 0, lastError: null, nextAttemptAt: null, updatedAt: new Date() })
        .where(eq(evolutionCyclesTable.id, cycle.id));
    }
    await cycleEvent(cycle, `Giro ${round.number} del ciclo di evoluzione chiuso: ${outcome}.`);
  }
  logger.info({ cycleId: round.cycleId, roundId: round.id, status }, "Giro del ciclo di evoluzione chiuso");
  return true;
}

/** Giro `implementing` da oltre 72 ore (orologio del DB) con il ciclo attivo → `blocked` «giro scaduto». */
async function expireIfStale(round: EvolutionRound): Promise<void> {
  const [stale] = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .innerJoin(evolutionCyclesTable, eq(evolutionCyclesTable.id, evolutionRoundsTable.cycleId))
    .where(
      and(
        eq(evolutionRoundsTable.id, round.id),
        eq(evolutionRoundsTable.status, "implementing"),
        eq(evolutionCyclesTable.status, "active"),
        sql`${evolutionRoundsTable.implementationStartedAt} < now() - make_interval(hours => ${IMPLEMENTING_MAX_HOURS})`,
      ),
    )
    .limit(1);
  if (stale) await closeTeamRound(round, "blocked", EVOLUTION_MESSAGES.roundExpired);
}

/**
 * Lavoro del giro: quello già legato, altrimenti il primo lavoro della squadra creato dopo il messaggio «Implementa» e non
 * seguito da un altro giro.
 */
async function roundWork(round: EvolutionRound): Promise<TeamWork | null> {
  if (round.workId !== null) {
    const [work] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, round.workId)).limit(1);
    return work ?? null;
  }
  if (round.teamInstanceId === null || round.implementationStartedAt === null) return null;
  const [work] = await db
    .select()
    .from(teamWorksTable)
    // Confronto tutto nel DB (stesso orologio, nessuna data JavaScript come parametro di un `timestamp` senza fuso)
    .where(
      and(
        eq(teamWorksTable.instanceId, round.teamInstanceId),
        sql`${teamWorksTable.createdAt} >= (select r.implementation_started_at from evolution_rounds r where r.id = ${round.id})`,
        // Un lavoro già seguito da un altro giro non si riprende
        sql`not exists (select 1 from evolution_rounds r where r.work_id = ${teamWorksTable.id})`,
      ),
    )
    .orderBy(teamWorksTable.number)
    .limit(1);
  if (!work) return null;
  await db
    .update(evolutionRoundsTable)
    .set({ workId: work.id })
    .where(and(eq(evolutionRoundsTable.id, round.id), sql`${evolutionRoundsTable.workId} is null`));
  return work;
}

/**
 * Fa seguire al giro il lavoro della squadra del ciclo (spec §15.8), con UPDATE condizionati: lavoro in prova con la voce
 * «Porta in produzione» → `awaiting_release`; in produzione → `done`; abbandonato → `blocked` «nessuna voce completata»;
 * di nuovo aperto dopo la prova → `implementing` (timer ripartito), con la nota se l'utente ha rifiutato la voce. Un giro
 * `implementing` senza messaggio al capo lo riprova; senza lavoro o con il lavoro aperto scade dopo 72 ore.
 */
export async function syncRound(roundId: number): Promise<void> {
  const [round] = await db.select().from(evolutionRoundsTable).where(eq(evolutionRoundsTable.id, roundId)).limit(1);
  if (!round || (round.status !== "implementing" && round.status !== "awaiting_release")) return;
  if (round.status === "implementing" && round.implementationStartedAt === null) {
    await startImplementation(round.id);
    return;
  }
  const work = await roundWork(round);
  if (!work) {
    await expireIfStale(round);
    return;
  }
  switch (work.status) {
    case "open": {
      if (round.status === "implementing") {
        await expireIfStale(round);
        return;
      }
      // Voce rifiutata dall'utente (con la sua nota) o rilascio non riuscito: il lavoro riprende
      const [item] =
        round.pendingActionId === null
          ? []
          : await db
              .select({ status: pendingActionsTable.status, note: pendingActionsTable.decisionNote, decidedBy: pendingActionsTable.decidedBy })
              .from(pendingActionsTable)
              .where(eq(pendingActionsTable.id, round.pendingActionId))
              .limit(1);
      const note = item?.status === "rejected" && item.decidedBy !== null && item.note?.trim() ? item.note.trim().slice(0, 500) : null;
      const [back] = await db
        .update(evolutionRoundsTable)
        .set({
          status: "implementing",
          pendingActionId: null,
          implementationStartedAt: sql`now()`,
          outcome: truncate(item?.status === "rejected" ? "Porta in produzione rifiutata: il lavoro riprende" : "Porta in produzione non riuscita: il lavoro riprende"),
          ...(note !== null ? { rejectionNote: note } : {}),
        })
        .where(and(eq(evolutionRoundsTable.id, round.id), eq(evolutionRoundsTable.status, "awaiting_release")))
        .returning({ id: evolutionRoundsTable.id });
      if (back) logger.info({ cycleId: round.cycleId, roundId: round.id, note: note !== null }, "Giro del ciclo di nuovo in implementazione");
      return;
    }
    case "awaiting_release":
    case "releasing": {
      if (work.pendingActionId === null) return;
      if (round.status === "awaiting_release" && round.pendingActionId === work.pendingActionId) return;
      const [moved] = await db
        .update(evolutionRoundsTable)
        .set({ status: "awaiting_release", pendingActionId: work.pendingActionId, outcome: awaitingReleaseOutcome(work.number) })
        .where(and(eq(evolutionRoundsTable.id, round.id), inArray(evolutionRoundsTable.status, [...TEAM_STATUSES])))
        .returning({ id: evolutionRoundsTable.id });
      if (moved && round.status === "implementing") {
        const [cycle] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.id, round.cycleId)).limit(1);
        if (cycle) await cycleEvent(cycle, `Giro ${round.number} del ciclo di evoluzione: ${awaitingReleaseOutcome(work.number)}.`);
      }
      return;
    }
    case "released":
      await closeTeamRound(round, "done", releasedOutcome(work.number));
      return;
    case "abandoned":
      await closeTeamRound(round, "blocked", EVOLUTION_MESSAGES.nothingCompleted);
      return;
  }
}

/** Cambio di stato di un lavoro della squadra: fa avanzare i giri aperti che la seguono. */
export async function syncTeamRounds(instanceId: number): Promise<void> {
  const rows = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .where(and(eq(evolutionRoundsTable.teamInstanceId, instanceId), inArray(evolutionRoundsTable.status, [...TEAM_STATUSES])));
  for (const r of rows) await syncRound(r.id);
}

/** Controllo periodico dei giri che seguono la squadra (al più `limit`). */
export async function syncOpenTeamRounds(limit = 20): Promise<void> {
  const rows = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .where(inArray(evolutionRoundsTable.status, [...TEAM_STATUSES]))
    .limit(limit);
  for (const r of rows) {
    try {
      await syncRound(r.id);
    } catch (err) {
      logger.error({ roundId: r.id, errName: err instanceof Error ? err.name : "unknown" }, "Avanzamento del giro con la squadra non riuscito");
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
 * Ferma il ciclo (spec §8 e §15.8): pausa «fermato dall'utente»; giro `analyzing|approving` → `stopped` con l'analisi fermata
 * (in questo processo col segnale, altrimenti chiusa nel DB se ancora in coda o in corso). Un giro che segue la squadra
 * (`implementing|awaiting_release`) resta aperto e riprende con «Riprendi». Squadra del ciclo: compiti in coda e in attesa del
 * nodo annullati (nel PLAN `failed` «ciclo di evoluzione fermato»); turni, compiti e merge automatici restano fermi finché il
 * ciclo è in pausa (`cyclePausedForTeam`). La voce «Porta in produzione» aperta resta decidibile.
 */
export async function stopCycle(appId: number): Promise<EvolutionCycle> {
  const cycle = await requireCycle(appId);
  const { updated, analysisIds, cancelled } = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(evolutionCyclesTable)
      .set({ status: "paused", pausedReason: EVOLUTION_MESSAGES.stoppedByUser, updatedAt: now })
      .where(eq(evolutionCyclesTable.id, cycle.id))
      .returning();
    const stopped = await tx
      .update(evolutionRoundsTable)
      .set({ status: "stopped", outcome: EVOLUTION_MESSAGES.stoppedByUser, finishedAt: now })
      .where(and(eq(evolutionRoundsTable.cycleId, cycle.id), inArray(evolutionRoundsTable.status, ["analyzing", "approving"])))
      .returning({ analysisId: evolutionRoundsTable.analysisId });
    const tasks =
      row!.teamInstanceId === null
        ? []
        : await tx
            .update(teamTasksTable)
            .set({ status: "cancelled", outcome: EVOLUTION_MESSAGES.cyclePaused, finishedAt: now })
            .where(and(eq(teamTasksTable.instanceId, row!.teamInstanceId), inArray(teamTasksTable.status, ["queued", "waiting_node"])))
            .returning({ planTaskId: teamTasksTable.planTaskId });
    if (row!.teamInstanceId !== null) await cycleEvent(row!, `Ciclo di evoluzione in pausa: ${EVOLUTION_MESSAGES.stoppedByUser}`, tx);
    return {
      updated: row!,
      analysisIds: stopped.map((s) => s.analysisId).filter((id): id is number => id !== null),
      cancelled: tasks.map((t) => t.planTaskId),
    };
  });
  for (const id of analysisIds) {
    if (abortAnalysis(id)) continue;
    await db
      .update(analysesTable)
      .set({ status: "failed", error: EVOLUTION_MESSAGES.analysisStopped, finishedAt: new Date() })
      .where(and(eq(analysesTable.id, id), inArray(analysesTable.status, ["queued", "running"])));
  }
  // Dopo il commit, come nella chiusura della squadra: i compiti annullati non restano «in corso» nel PLAN
  if (updated.teamInstanceId !== null && cancelled.length > 0) {
    await patchPlan(updated.teamInstanceId, {
      tasks: cancelled.map((id) => ({ id, status: "failed" as const, outcome: EVOLUTION_MESSAGES.cyclePaused })),
    });
  }
  logger.info({ cycleId: cycle.id, rounds: analysisIds.length, tasks: cancelled.length }, "Ciclo di evoluzione fermato");
  return updated;
}

/**
 * Riprende il ciclo: serve un consenso valido dato da chi riprende (chi paga resta chi ha acconsentito), altrimenti
 * «consenso da rinnovare». Errori azzerati e giro dovuto subito. Con la squadra del ciclo attiva: il timer del giro che la
 * segue riparte, il capo riceve «riprendi il lavoro» (con i motivi accumulati nel turno in coda) e ripartono i compiti in coda.
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
  if (row!.teamInstanceId !== null) {
    const teamId = row!.teamInstanceId;
    await db
      .update(evolutionRoundsTable)
      .set({ implementationStartedAt: sql`now()` })
      .where(
        and(
          eq(evolutionRoundsTable.cycleId, cycle.id),
          eq(evolutionRoundsTable.status, "implementing"),
          sql`${evolutionRoundsTable.implementationStartedAt} is not null`,
        ),
      );
    const [team] = await db.select({ status: teamInstancesTable.status }).from(teamInstancesTable).where(eq(teamInstancesTable.id, teamId)).limit(1);
    if (team?.status === "active") {
      await enqueueTurnReason(teamId, { type: "request", text: EVOLUTION_MESSAGES.resumeRequest, source: "system" });
      void pumpTasks(teamId).catch((err: unknown) =>
        logger.error({ instanceId: teamId, errName: err instanceof Error ? err.name : "unknown" }, "Ripresa dei compiti della squadra del ciclo non riuscita"),
      );
    }
  }
  logger.info({ cycleId: cycle.id }, "Ciclo di evoluzione ripreso");
  return row!;
}

/**
 * Elimina il ciclo e i suoi giri; un ciclo attivo o con un giro `analyzing|approving` va prima fermato. La squadra del ciclo
 * resta (si chiude a mano) e, senza ciclo, torna al suo tetto di squadra.
 */
export async function deleteCycle(appId: number): Promise<void> {
  const cycle = await requireCycle(appId);
  const [analyzing] = await db
    .select({ id: evolutionRoundsTable.id })
    .from(evolutionRoundsTable)
    .where(and(eq(evolutionRoundsTable.cycleId, cycle.id), inArray(evolutionRoundsTable.status, ["analyzing", "approving"])))
    .limit(1);
  if (cycle.status === "active" || analyzing) throw new EvolutionError(409, EVOLUTION_MESSAGES.stopBeforeDelete);
  await db
    .delete(evolutionCyclesTable)
    .where(and(eq(evolutionCyclesTable.id, cycle.id), eq(evolutionCyclesTable.status, "paused")));
  logger.info({ cycleId: cycle.id }, "Ciclo di evoluzione eliminato");
}
