import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, localJobsTable, localMachinesTable, type LocalJob, type LocalJobCurrentItem } from "@workspace/db";
import { FALLBACK_REQUIRED } from "../ai/choice";
import { CONNECTED_WINDOW_MS, isMachineActive } from "./machines";
import { hashToken, newToken, tokenKind } from "./tokens";

/**
 * Coda dei lavori dell'agente locale. Un'analisi o una run assegnata a una macchina diventa un lavoro: lo prende
 * il runner della macchina (`GET /runner/next`) o una sessione di chat (modalità C); se il runner non è collegato
 * si applica la scelta della console o la regola dell'agente (riserva, attesa, rinvio).
 *
 * Una sola istanza dell'API: le attese (`awaitDispatch`, `runItem`, l'attesa lunga del runner) si risvegliano con
 * notifiche in memoria e rileggono lo stato dal DB; i timer non tengono in vita il processo. Un riavvio chiude
 * tutti i lavori aperti (`failOpenLocalJobs`).
 */

export const LOCAL_NOT_CONNECTED = "agente locale non collegato";
export const LOCAL_DISCONNECTED = "agente locale disconnesso";
export const JOB_EXPIRED = "lavoro scaduto";
export const JOB_NOT_FOUND = "lavoro non trovato";
export const JOB_CANCELLED = "lavoro annullato";
export const MACHINE_UNAVAILABLE = "macchina non disponibile";
const NOT_WAITING = "il lavoro non è in attesa di una scelta";
export const ITEM_REPLACED = "compito non più in corso";
export const RESTARTED = "interrotto dal riavvio";
export const SESSION_MISSING = "sessione di Claude Code da riprendere non disponibile";
/** Claude Code è uscito con errore senza consegnare (limite dell'abbonamento, accesso scaduto…): nessuna correzione. */
export const CLAUDE_EXIT_ERROR = "Claude Code terminato con errore";
// Il lavoro non serve più: la run o l'analisi prosegue col modello di riserva
const FALLBACK_CHOSEN = "eseguito con il modello di riserva";

// Errori della coda dei lavori che `runItem` può lanciare (anche come `error` del lavoro): testi fissi, salvabili
const QUEUE_MESSAGES: ReadonlySet<string> = new Set([
  JOB_EXPIRED,
  JOB_NOT_FOUND,
  JOB_CANCELLED,
  ITEM_REPLACED,
  RESTARTED,
  LOCAL_DISCONNECTED,
  LOCAL_NOT_CONNECTED,
  MACHINE_UNAVAILABLE,
  SESSION_MISSING,
]);

/** Errore della coda con un messaggio fisso (da riportare così com'è nella run o nell'analisi). */
export function isQueueError(err: unknown): err is Error {
  return err instanceof LocalJobError || (err instanceof Error && QUEUE_MESSAGES.has(err.message));
}

export class LocalJobError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalJobError";
  }
}

type JobKind = LocalJob["kind"];
type JobStatus = LocalJob["status"];

// Non ancora preso / preso e aperto / tutti gli aperti
const UNCLAIMED: JobStatus[] = ["queued", "waiting_choice", "postponed"];
const CLAIMED: JobStatus[] = ["claimed", "running", "paused"];
const OPEN: JobStatus[] = [...UNCLAIMED, ...CLAIMED];
const ENDED: JobStatus[] = ["completed", "failed", "cancelled"];

export type LocalJobTimings = {
  /** Runner "collegato": segnale di vita della macchina entro questo tempo. */
  connectedWindowMs: number;
  /** Con il runner collegato, tempo concesso per prendere il lavoro. */
  claimWindowMs: number;
  /** Attesa lunga di `GET /runner/next`. */
  longPollMs: number;
  /** Senza segnale di vita per questo tempo durante un compito: "agente locale disconnesso". */
  heartbeatTimeoutMs: number;
  /** Scelta "attendi" (e finestra della scelta stessa): per tipo di lavoro. */
  waitMs: Record<JobKind, number>;
  /** Scelta "posticipa" e regola `postpone`. */
  postponeMs: number;
  /** Durata del token di lavoro, rinnovata a ogni compito. */
  jobTokenTtlMs: number;
};

const DEFAULT_TIMINGS: LocalJobTimings = {
  connectedWindowMs: CONNECTED_WINDOW_MS,
  claimWindowMs: 10_000,
  longPollMs: 25_000,
  heartbeatTimeoutMs: 60_000,
  waitMs: { analysis: 30 * 60_000, run: 2 * 60_000 },
  postponeMs: 24 * 60 * 60_000,
  jobTokenTtlMs: 30 * 60_000,
};

let timings: LocalJobTimings = DEFAULT_TIMINGS;

export function localJobTimings(): LocalJobTimings {
  return timings;
}

/** Tempi sostituibili nei test; restituisce la funzione che ripristina i precedenti. */
export function setLocalJobTimings(patch: Partial<LocalJobTimings>): () => void {
  const previous = timings;
  timings = { ...timings, ...patch };
  return () => {
    timings = previous;
  };
}

// --- Notifiche in memoria ---------------------------------------------------------------------------------------
// Ogni chiave (lavoro o macchina) ha un contatore: chi attende ne fotografa il valore PRIMA di leggere il DB, così
// una notifica arrivata tra la lettura e l'attesa non va persa.

const versions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

const jobKey = (id: number) => `job:${id}`;
const machineKey = (id: number) => `machine:${id}`;

function notify(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1);
  for (const fn of listeners.get(key) ?? []) fn();
}

type Snapshot = Array<[string, number]>;

function snapshot(...keys: string[]): Snapshot {
  return keys.map((k) => [k, versions.get(k) ?? 0]);
}

/** Attende una notifica successiva alla fotografia, il tempo indicato o l'annullamento. */
function waitForChange(snap: Snapshot, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || snap.some(([k, v]) => (versions.get(k) ?? 0) !== v)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const [k] of snap) {
        const set = listeners.get(k);
        set?.delete(done);
        if (set && set.size === 0) listeners.delete(k);
      }
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    timer.unref();
    for (const [k] of snap) {
      let set = listeners.get(k);
      if (!set) listeners.set(k, (set = new Set()));
      set.add(done);
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// --- Stato in memoria dei lavori ----------------------------------------------------------------------------------

export type OfflinePolicy = { kind: "fallback" | "wait_then_fallback" | "postpone"; waitS: number };

/**
 * Scadenza di un lavoro non ancora preso e cosa fare allo scadere: regole offline, `failed` ("attendi" e finestra
 * della scelta), `cancelled` ("posticipa"), riserva.
 */
type Pending = { deadline: number; onExpire: "offline" | "fail" | "cancel" | "fallback" };

const pending = new Map<number, Pending>();
const policies = new Map<number, OfflinePolicy>();

export type ItemResult = {
  sessionId: string | null;
  exit: "done" | "error";
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Presente se il compito è stato chiuso dal suo consumatore (`completeItem`) prima del done del runner. */
  completion?: unknown;
};

// Compiti in attesa di `runItem`, per id del compito
// `onDelivered`: avviso al consumatore quando il compito arriva a chi lo esegue (runner o chat)
const activeItems = new Map<string, { jobId: number; result: ItemResult | null; onDelivered?: () => void }>();
// Compiti del runner chiusi dal consumatore prima del done: il done arriva dopo e porta la sessione da riprendere.
// `since`: momento della chiusura (una ripresa attende il done al più `heartbeatTimeoutMs`)
const lingeringItems = new Map<string, { jobId: number; since: number }>();

/** Il lavoro ha un compito chiuso dal consumatore il cui done (con la sessione) può ancora arrivare. */
function awaitingDone(jobId: number, now = Date.now()): boolean {
  for (const l of lingeringItems.values()) if (l.jobId === jobId && now - l.since < timings.heartbeatTimeoutMs) return true;
  return false;
}

/** Lavoro finito: libera tutto lo stato in memoria (chi attendeva è già stato notificato). */
function forgetJob(jobId: number): void {
  pending.delete(jobId);
  policies.delete(jobId);
  versions.delete(jobKey(jobId));
  for (const [itemId, l] of lingeringItems) if (l.jobId === jobId) lingeringItems.delete(itemId);
}

// --- Lettura ------------------------------------------------------------------------------------------------------

async function loadJob(jobId: number): Promise<LocalJob | null> {
  const [row] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, jobId)).limit(1);
  return row ?? null;
}

async function machineConnected(machineId: number): Promise<boolean> {
  const [m] = await db
    .select({ lastSeenAt: localMachinesTable.lastSeenAt, revokedAt: localMachinesTable.revokedAt })
    .from(localMachinesTable)
    .where(eq(localMachinesTable.id, machineId))
    .limit(1);
  return !!m && m.revokedAt === null && m.lastSeenAt !== null && Date.now() - m.lastSeenAt.getTime() < timings.connectedWindowMs;
}

const currentItemIs = (itemId: string) => sql`${localJobsTable.currentItem}->>'id' = ${itemId}`;

/** Aggiorna un lavoro solo se è in uno degli stati indicati; restituisce la riga aggiornata. */
async function updateIf(jobId: number, statuses: JobStatus[], set: Partial<typeof localJobsTable.$inferInsert>, extra?: ReturnType<typeof sql>) {
  const where = and(eq(localJobsTable.id, jobId), inArray(localJobsTable.status, statuses), extra);
  const [row] = await db
    .update(localJobsTable)
    .set({ ...set, updatedAt: new Date() })
    .where(where)
    .returning();
  if (row) {
    notify(jobKey(jobId));
    if (ENDED.includes(row.status)) forgetJob(jobId);
  }
  return row ?? null;
}

// --- Creazione e assegnazione -------------------------------------------------------------------------------------

export async function createLocalJob(input: {
  userId: number;
  machineId: number;
  kind: "analysis" | "run";
  analysisId?: number;
  runId?: number;
  fallbackAiModelId: number;
  origin: "console" | "app";
  policy?: OfflinePolicy;
}): Promise<LocalJob> {
  // Il DB non ha un CHECK: un lavoro si riferisce esattamente a una analisi o a una run, secondo il tipo
  const [own, other] = input.kind === "analysis" ? [input.analysisId, input.runId] : [input.runId, input.analysisId];
  if (own == null || other != null) {
    throw new Error(`lavoro ${input.kind}: serve solo ${input.kind === "analysis" ? "analysisId" : "runId"}`);
  }
  if (!(await isMachineActive(input.machineId, input.userId))) throw new LocalJobError(400, MACHINE_UNAVAILABLE);
  const [job] = await db
    .insert(localJobsTable)
    .values({
      userId: input.userId,
      machineId: input.machineId,
      kind: input.kind,
      analysisId: input.kind === "analysis" ? own : null,
      runId: input.kind === "run" ? own : null,
      origin: input.origin,
      fallbackAiModelId: input.fallbackAiModelId,
    })
    .returning();
  if (input.policy) policies.set(job!.id, input.policy);
  notify(machineKey(input.machineId));
  return job!;
}

export type DispatchOutcome = { kind: "local" } | { kind: "fallback"; aiModelId: number } | { kind: "cancelled"; error: string };

/** Esito definitivo dell'assegnazione, se il lavoro non è più in attesa. */
function settledOutcome(job: LocalJob | null): DispatchOutcome | null {
  if (!job) return { kind: "cancelled", error: JOB_NOT_FOUND };
  if (CLAIMED.includes(job.status) || job.status === "completed") return { kind: "local" };
  if (job.status === "cancelled" && job.error === FALLBACK_CHOSEN) {
    return job.fallbackAiModelId === null
      ? { kind: "cancelled", error: FALLBACK_REQUIRED }
      : { kind: "fallback", aiModelId: job.fallbackAiModelId };
  }
  if (job.status === "failed" || job.status === "cancelled") return { kind: "cancelled", error: job.error ?? JOB_CANCELLED };
  return null;
}

/** Passa alla riserva (senza modello di riserva il lavoro si annulla con il messaggio fisso). */
async function useFallback(job: LocalJob): Promise<void> {
  const error = job.fallbackAiModelId === null ? FALLBACK_REQUIRED : FALLBACK_CHOSEN;
  await updateIf(job.id, UNCLAIMED, { status: "cancelled", error });
}

/** Runner non collegato (o presa non arrivata): scelta della console o regola dell'agente. */
async function goOffline(job: LocalJob): Promise<void> {
  const now = Date.now();
  if (job.origin === "console") {
    pending.set(job.id, { deadline: now + timings.waitMs[job.kind], onExpire: "fail" });
    await updateIf(job.id, UNCLAIMED, { status: "waiting_choice" });
    return;
  }
  const policy = policies.get(job.id) ?? { kind: "fallback", waitS: 0 };
  if (policy.kind === "wait_then_fallback") {
    pending.set(job.id, { deadline: now + policy.waitS * 1000, onExpire: "fallback" });
  } else if (policy.kind === "postpone") {
    pending.set(job.id, { deadline: now + timings.postponeMs, onExpire: "cancel" });
    await updateIf(job.id, UNCLAIMED, { status: "postponed" });
  } else {
    pending.delete(job.id);
    await useFallback(job);
  }
}

/**
 * Attende che il lavoro venga preso (`local`), che si passi alla riserva (`fallback`) o che sia annullato.
 * Con il runner collegato concede `claimWindowMs` per la presa; poi (o subito, se non è collegato) la console
 * sceglie (`waiting_choice`) o si applica la regola dell'agente. Il segnale annulla il lavoro.
 */
export async function awaitDispatch(jobId: number, signal: AbortSignal): Promise<DispatchOutcome> {
  try {
    const first = await loadJob(jobId);
    const settled = settledOutcome(first);
    if (settled) return settled;
    const connected = await machineConnected(first!.machineId);
    pending.set(jobId, { deadline: Date.now() + (connected ? timings.claimWindowMs : 0), onExpire: "offline" });

    for (;;) {
      const snap = snapshot(jobKey(jobId));
      const job = await loadJob(jobId);
      const outcome = settledOutcome(job);
      if (outcome) return outcome;
      if (signal.aborted) {
        await updateIf(jobId, OPEN, { status: "cancelled", error: JOB_CANCELLED });
        return { kind: "cancelled", error: JOB_CANCELLED };
      }
      const p = pending.get(jobId) ?? { deadline: 0, onExpire: "offline" };
      const left = p.deadline - Date.now();
      if (left > 0) {
        await waitForChange(snap, left, signal);
        continue;
      }
      if (p.onExpire === "offline") await goOffline(job!);
      else if (p.onExpire === "fallback") await useFallback(job!);
      else await updateIf(jobId, UNCLAIMED, { status: p.onExpire === "cancel" ? "cancelled" : "failed", error: LOCAL_NOT_CONNECTED });
    }
  } finally {
    // Scadenze e regola servono solo a questa attesa; il resto si libera alla fine del lavoro
    pending.delete(jobId);
    policies.delete(jobId);
  }
}

/** Scelta della console per un lavoro in `waiting_choice` o `postponed` dell'utente. */
export async function chooseForJob(jobId: number, userId: number, choice: "fallback" | "wait" | "postpone"): Promise<void> {
  const [job] = await db
    .select()
    .from(localJobsTable)
    .where(and(eq(localJobsTable.id, jobId), eq(localJobsTable.userId, userId)))
    .limit(1);
  if (!job) throw new LocalJobError(404, JOB_NOT_FOUND);
  const choosable: JobStatus[] = ["waiting_choice", "postponed"];
  if (!choosable.includes(job.status)) throw new LocalJobError(409, NOT_WAITING);

  let updated: LocalJob | null;
  if (choice === "fallback") {
    if (job.fallbackAiModelId === null) throw new LocalJobError(400, FALLBACK_REQUIRED);
    updated = await updateIf(jobId, choosable, { status: "cancelled", error: FALLBACK_CHOSEN });
  } else {
    const deadline = Date.now() + (choice === "wait" ? timings.waitMs[job.kind] : timings.postponeMs);
    // La scadenza vale per l'attesa in corso di awaitDispatch (se non c'è, nessuno la userebbe)
    if (pending.has(jobId)) pending.set(jobId, { deadline, onExpire: choice === "wait" ? "fail" : "cancel" });
    updated = await updateIf(jobId, choosable, { status: choice === "wait" ? "queued" : "postponed" });
  }
  if (!updated) throw new LocalJobError(409, NOT_WAITING);
}

/**
 * Presa atomica di un lavoro non ancora preso: dal runner della sua macchina o dalla chat del suo utente.
 * Chi perde la corsa (o tenta un lavoro altrui) riceve "lavoro non trovato". Genera il token del lavoro.
 */
export async function claimJob(
  jobId: number,
  claimer: { by: "runner"; machineId: number } | { by: "chat"; userId: number },
): Promise<{ job: LocalJob; jobToken: string }> {
  const { token, hash } = newToken("job");
  const owner = claimer.by === "runner" ? eq(localJobsTable.machineId, claimer.machineId) : eq(localJobsTable.userId, claimer.userId);
  const now = new Date();
  const [job] = await db
    .update(localJobsTable)
    .set({
      status: "claimed",
      claimedBy: claimer.by,
      jobTokenHash: hash,
      jobTokenExpiresAt: new Date(now.getTime() + timings.jobTokenTtlMs),
      heartbeatAt: now,
      error: null,
      updatedAt: now,
    })
    .where(and(eq(localJobsTable.id, jobId), owner, inArray(localJobsTable.status, UNCLAIMED)))
    .returning();
  if (!job) throw new LocalJobError(404, JOB_NOT_FOUND);
  notify(jobKey(jobId));
  return { job, jobToken: token };
}

// --- Protocollo del runner ----------------------------------------------------------------------------------------

export type RunnerDelivery = { jobId: number; itemId: string; jobToken: string; prompt: string; resumeSessionId: string | null };

/**
 * Consegna al runner il compito in attesa di un suo lavoro, con un token di lavoro nuovo (il precedente decade).
 * Una ripresa (`resume`) aspetta il done del compito precedente, che porta la sessione (con più posti il runner
 * potrebbe chiedere lavoro prima che il Claude precedente sia uscito); senza sessione il lavoro fallisce con un
 * messaggio fisso: mai una ripresa in una sessione nuova, senza contesto.
 */
async function deliverPending(machineId: number): Promise<RunnerDelivery | null> {
  const candidates = await db
    .select({ id: localJobsTable.id, item: localJobsTable.currentItem, sessionId: localJobsTable.claudeSessionId })
    .from(localJobsTable)
    .where(
      and(
        eq(localJobsTable.machineId, machineId),
        eq(localJobsTable.claimedBy, "runner"),
        eq(localJobsTable.status, "claimed"),
        isNotNull(localJobsTable.currentItem),
      ),
    )
    .orderBy(asc(localJobsTable.id))
    .limit(10);
  for (const candidate of candidates) {
    const item = candidate.item;
    if (!item) continue;
    if (item.resume && awaitingDone(candidate.id)) continue;
    if (item.resume && !candidate.sessionId) {
      await updateIf(candidate.id, ["claimed"], { status: "failed", error: SESSION_MISSING }, currentItemIs(item.id));
      continue;
    }
    const { token, hash } = newToken("job");
    const now = new Date();
    const job = await updateIf(
      candidate.id,
      ["claimed"],
      { status: "running", heartbeatAt: now, jobTokenHash: hash, jobTokenExpiresAt: new Date(now.getTime() + timings.jobTokenTtlMs) },
      currentItemIs(item.id),
    );
    if (!job) continue;
    activeItems.get(item.id)?.onDelivered?.();
    const resumeSessionId = item.resume ? job.claudeSessionId : null;
    return { jobId: job.id, itemId: item.id, jobToken: token, prompt: item.prompt, resumeSessionId };
  }
  return null;
}

/**
 * Consegna persa (il runner ha chiuso la richiesta prima della risposta): il compito torna in attesa di consegna
 * e arriva alla prossima richiesta, con un token nuovo.
 */
export async function undeliverItem(jobId: number, itemId: string): Promise<void> {
  const job = await updateIf(jobId, ["running"], { status: "claimed" }, currentItemIs(itemId));
  if (job) notify(machineKey(job.machineId));
}

/** Prende il primo lavoro libero della macchina; false se non ce ne sono (o li ha presi qualcun altro). */
async function claimNextFor(machineId: number): Promise<boolean> {
  const candidates = await db
    .select({ id: localJobsTable.id })
    .from(localJobsTable)
    .where(and(eq(localJobsTable.machineId, machineId), inArray(localJobsTable.status, UNCLAIMED)))
    .orderBy(asc(localJobsTable.id))
    .limit(5);
  for (const { id } of candidates) {
    try {
      await claimJob(id, { by: "runner", machineId });
      return true;
    } catch (err) {
      if (!(err instanceof LocalJobError)) throw err;
    }
  }
  return false;
}

/**
 * Attesa lunga del runner (`GET /runner/next`): segna il segnale di vita della macchina, consegna il compito in
 * attesa di un lavoro già preso o prende un lavoro nuovo e ne attende il primo compito. Null allo scadere.
 */
export async function nextForMachine(machineId: number, signal: AbortSignal): Promise<RunnerDelivery | null> {
  await db.update(localMachinesTable).set({ lastSeenAt: new Date() }).where(eq(localMachinesTable.id, machineId));
  const until = Date.now() + timings.longPollMs;
  // Al più un lavoro nuovo per richiesta: dopo la presa si attende il suo primo compito
  let claimed = false;
  while (!signal.aborted) {
    const snap = snapshot(machineKey(machineId));
    const delivery = await deliverPending(machineId);
    if (delivery && signal.aborted) {
      await undeliverItem(delivery.jobId, delivery.itemId);
      return null;
    }
    if (delivery) return delivery;
    if (!claimed && (await claimNextFor(machineId))) {
      claimed = true;
      continue;
    }
    const left = until - Date.now();
    if (left <= 0) return null;
    await waitForChange(snap, left, signal);
  }
  return null;
}

/** Lavoro della macchina per le route del runner: aperto, oppure "lavoro scaduto" / "lavoro non trovato". */
async function runnerJob(machineId: number, jobId: number): Promise<LocalJob> {
  const [job] = await db
    .select()
    .from(localJobsTable)
    .where(and(eq(localJobsTable.id, jobId), eq(localJobsTable.machineId, machineId), eq(localJobsTable.claimedBy, "runner")))
    .limit(1);
  if (!job) throw new LocalJobError(404, JOB_NOT_FOUND);
  if (!CLAIMED.includes(job.status)) throw new LocalJobError(410, JOB_EXPIRED);
  return job;
}

/** Segnale di vita: rinnova anche la scadenza del token (vale finché il lavoro è vivo). */
function aliveNow() {
  const now = new Date();
  return { heartbeatAt: now, jobTokenExpiresAt: new Date(now.getTime() + timings.jobTokenTtlMs) };
}

/** Segnale di vita del runner per un lavoro in corso (vale anche per la macchina). */
export async function heartbeatJob(machineId: number, jobId: number): Promise<void> {
  await runnerJob(machineId, jobId);
  await db.update(localMachinesTable).set({ lastSeenAt: new Date() }).where(eq(localMachinesTable.id, machineId));
  await updateIf(jobId, CLAIMED, aliveNow());
}

/** Sessione di Claude Code di un compito già sostituito dal successivo: la si salva comunque (servirà a riprendere). */
async function saveSession(jobId: number, machineId: number, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  await db
    .update(localJobsTable)
    .set({ claudeSessionId: sessionId, updatedAt: new Date() })
    .where(and(eq(localJobsTable.id, jobId), eq(localJobsTable.machineId, machineId), inArray(localJobsTable.status, CLAIMED)));
}

/**
 * Fine di un compito riportata dal runner: salva la sessione di Claude Code, libera il compito e risveglia
 * `runItem`. Lavoro chiuso: completato → nulla da fare; fallito o annullato → "lavoro scaduto".
 */
export async function reportItemDone(machineId: number, itemId: string, result: Omit<ItemResult, "completion">): Promise<void> {
  const [job] = await db
    .select()
    .from(localJobsTable)
    .where(and(eq(localJobsTable.machineId, machineId), eq(localJobsTable.claimedBy, "runner"), currentItemIs(itemId)))
    .limit(1);
  if (job) {
    if (job.status === "completed") return;
    if (!CLAIMED.includes(job.status)) throw new LocalJobError(410, JOB_EXPIRED);
    const now = new Date();
    await db.update(localMachinesTable).set({ lastSeenAt: now }).where(eq(localMachinesTable.id, machineId));
    const freed = await updateIf(
      job.id,
      CLAIMED,
      {
        claudeSessionId: result.sessionId ?? job.claudeSessionId,
        currentItem: null,
        status: job.status === "running" ? "claimed" : job.status,
        heartbeatAt: now,
      },
      currentItemIs(itemId),
    );
    // Il compito è stato sostituito tra la lettura e l'aggiornamento: la sessione si salva lo stesso
    if (!freed) await saveSession(job.id, machineId, result.sessionId);
  } else {
    // Compito chiuso dal consumatore e già sostituito da quello successivo: resta da salvare la sessione
    const jobId = lingeringItems.get(itemId)?.jobId;
    const lingering = jobId === undefined ? null : await loadJob(jobId);
    if (!lingering || lingering.machineId !== machineId) throw new LocalJobError(404, JOB_NOT_FOUND);
    if (!CLAIMED.includes(lingering.status)) throw new LocalJobError(410, JOB_EXPIRED);
    await saveSession(lingering.id, machineId, result.sessionId);
  }
  // Una ripresa in attesa di questo done può partire
  if (lingeringItems.delete(itemId)) notify(machineKey(machineId));
  const entry = activeItems.get(itemId);
  if (entry && !entry.result) {
    entry.result = { sessionId: result.sessionId, exit: result.exit, usage: result.usage };
    notify(jobKey(entry.jobId));
  }
}

// --- Compiti ------------------------------------------------------------------------------------------------------

/** Ultimo segnale di vita di un lavoro del runner: compito consegnato → il lavoro; in attesa di consegna → anche la macchina. */
async function lastSignOfLife(job: LocalJob): Promise<number> {
  let alive = job.heartbeatAt?.getTime() ?? 0;
  if (job.status === "claimed") {
    const [m] = await db
      .select({ lastSeenAt: localMachinesTable.lastSeenAt })
      .from(localMachinesTable)
      .where(eq(localMachinesTable.id, job.machineId))
      .limit(1);
    alive = Math.max(alive, m?.lastSeenAt?.getTime() ?? 0);
  }
  return alive;
}

/**
 * Pubblica un compito in `current_item` e attende che finisca: done del runner o `completeItem` del consumatore,
 * il primo che arriva. Con `resume` il runner riceve la sessione di Claude Code salvata nel lavoro al momento della
 * consegna (scritta dal done del compito precedente, anche se arrivato dopo il completamento). Per i lavori del runner, senza segnale di vita per `heartbeatTimeoutMs` il lavoro fallisce
 * con "agente locale disconnesso"; nella chat (nessun runner) vale solo la durata massima del lavoro.
 * `onDelivered` avvisa quando il compito arriva al runner (o subito, nella chat).
 */
export async function runItem(
  jobId: number,
  item: { prompt: string; resume: boolean },
  signal: AbortSignal,
  opts: { onDelivered?: () => void } = {},
): Promise<ItemResult> {
  const before = await loadJob(jobId);
  if (!before || !CLAIMED.includes(before.status)) throw new Error(before?.error ?? JOB_EXPIRED);
  const current: LocalJobCurrentItem = { id: randomUUID(), ...item };
  const now = new Date();
  activeItems.set(current.id, { jobId, result: null, onDelivered: opts.onDelivered });
  try {
    const published = await updateIf(jobId, CLAIMED, {
      currentItem: current,
      // Il runner riceve il compito alla prossima richiesta (claimed → running); la chat lo legge subito
      status: before.claimedBy === "chat" ? "running" : "claimed",
      heartbeatAt: now,
      jobTokenExpiresAt: new Date(now.getTime() + timings.jobTokenTtlMs),
    });
    if (!published) throw new Error(JOB_EXPIRED);
    // La chat legge il compito appena pubblicato: per lei la consegna è adesso
    if (published.claimedBy === "chat") opts.onDelivered?.();
    notify(machineKey(published.machineId));

    for (;;) {
      const snap = snapshot(jobKey(jobId));
      const entry = activeItems.get(current.id)!;
      if (entry.result) return entry.result;
      if (signal.aborted) throw new Error(JOB_CANCELLED);
      const job = await loadJob(jobId);
      if (entry.result) return entry.result;
      if (!job || !CLAIMED.includes(job.status)) throw new Error(job?.error ?? JOB_EXPIRED);
      if (job.currentItem?.id !== current.id) throw new Error(ITEM_REPLACED);
      let wait = timings.longPollMs;
      if (job.claimedBy === "runner") {
        const left = (await lastSignOfLife(job)) + timings.heartbeatTimeoutMs - Date.now();
        if (left <= 0) {
          // Una sola transizione: solo se il compito è ancora questo e il lavoro è aperto
          const failed = await updateIf(jobId, CLAIMED, { status: "failed", error: LOCAL_DISCONNECTED }, currentItemIs(current.id));
          if (failed) throw new Error(LOCAL_DISCONNECTED);
          continue;
        }
        wait = left + 1;
      }
      await waitForChange(snap, wait, signal);
    }
  } finally {
    activeItems.delete(current.id);
  }
}

/**
 * Il consumatore del compito (consegna di una fase, fine di una run via MCP) lo dichiara finito: `runItem`
 * risolve con `completion`. Nella chat il compito si libera subito; col runner si attende il suo done per la
 * sessione. False se il compito non è quello in corso.
 */
export async function completeItem(jobId: number, itemId: string, payload: unknown): Promise<boolean> {
  const entry = activeItems.get(itemId);
  if (!entry || entry.jobId !== jobId || entry.result) return false;
  const job = await loadJob(jobId);
  if (!job || !CLAIMED.includes(job.status) || job.currentItem?.id !== itemId) return false;
  entry.result = { sessionId: null, exit: "done", usage: null, completion: payload };
  if (job.claimedBy === "chat") {
    await updateIf(jobId, CLAIMED, { currentItem: null, status: "claimed" }, currentItemIs(itemId));
  } else {
    lingeringItems.set(itemId, { jobId, since: Date.now() });
  }
  notify(jobKey(jobId));
  return true;
}

/** Ogni chiamata MCP di un lavoro preso dalla chat vale come segnale di vita. */
export async function touchJob(jobId: number): Promise<void> {
  await db
    .update(localJobsTable)
    .set(aliveNow())
    .where(and(eq(localJobsTable.id, jobId), inArray(localJobsTable.status, CLAIMED)));
}

// --- Token e chiusura ---------------------------------------------------------------------------------------------

/**
 * Lavoro aperto del token di lavoro, se non scaduto. La ricerca è per hash sull'indice unico: il token in chiaro
 * non si confronta mai con un valore salvato, quindi non serve un confronto a tempo costante.
 */
export async function jobByToken(token: string): Promise<LocalJob | null> {
  if (tokenKind(token) !== "job") return null;
  // Con la macchina revocata il token non vale più, anche se il lavoro non è (ancora) chiuso
  const [row] = await db
    .select({ job: localJobsTable })
    .from(localJobsTable)
    .innerJoin(localMachinesTable, eq(localJobsTable.machineId, localMachinesTable.id))
    .where(
      and(
        eq(localJobsTable.jobTokenHash, hashToken(token)),
        inArray(localJobsTable.status, CLAIMED),
        gt(localJobsTable.jobTokenExpiresAt, new Date()),
        isNull(localMachinesTable.revokedAt),
      ),
    )
    .limit(1);
  return row?.job ?? null;
}

/**
 * Run in attesa di conferma: il lavoro resta preso (con la sessione di Claude Code da riprendere) ma senza compito
 * in corso; la ripresa pubblica il compito successivo con `runItem`.
 */
export async function pauseLocalJob(jobId: number): Promise<void> {
  await updateIf(jobId, CLAIMED, { status: "paused" });
}

/** Chiude un lavoro aperto (il token smette di valere). */
export async function finishLocalJob(jobId: number, status: "completed" | "failed" | "cancelled", error: string | null = null): Promise<void> {
  await updateIf(jobId, OPEN, { status, error });
}

/** Lavori presi con il token scaduto (es. chat abbandonata): falliti con "lavoro scaduto". */
export async function expireLocalJobs(): Promise<number> {
  const rows = await db
    .update(localJobsTable)
    .set({ status: "failed", error: JOB_EXPIRED, updatedAt: new Date() })
    .where(and(inArray(localJobsTable.status, CLAIMED), lt(localJobsTable.jobTokenExpiresAt, new Date())))
    .returning({ id: localJobsTable.id });
  for (const { id } of rows) {
    notify(jobKey(id));
    forgetJob(id);
  }
  return rows.length;
}

/**
 * Macchina revocata: tutti i suoi lavori aperti falliscono con "macchina non disponibile" (i token di lavoro smettono
 * subito di valere). Chi attende (`awaitDispatch`, `runItem`) si risveglia e chiude run e analisi con lo stesso
 * messaggio; le run in pausa le chiude chi revoca. Restituisce i lavori chiusi.
 */
export async function closeMachineJobs(machineId: number): Promise<Array<{ id: number; runId: number | null; analysisId: number | null }>> {
  const rows = await db
    .update(localJobsTable)
    .set({ status: "failed", error: MACHINE_UNAVAILABLE, updatedAt: new Date() })
    .where(and(eq(localJobsTable.machineId, machineId), inArray(localJobsTable.status, OPEN)))
    .returning({ id: localJobsTable.id, runId: localJobsTable.runId, analysisId: localJobsTable.analysisId });
  for (const { id } of rows) {
    notify(jobKey(id));
    forgetJob(id);
  }
  if (rows.length > 0) notify(machineKey(machineId));
  return rows;
}

/** Avvio: i lavori aperti sono stati interrotti dal riavvio (run e analisi le chiudono i loro controlli). */
export async function failOpenLocalJobs(): Promise<number> {
  const rows = await db
    .update(localJobsTable)
    .set({ status: "failed", error: RESTARTED, updatedAt: new Date() })
    .where(inArray(localJobsTable.status, OPEN))
    .returning({ id: localJobsTable.id });
  for (const { id } of rows) {
    notify(jobKey(id));
    forgetJob(id);
  }
  return rows.length;
}

/** Lavori aperti dell'utente, per la console. */
export async function listOpenJobs(userId: number): Promise<LocalJob[]> {
  return db
    .select()
    .from(localJobsTable)
    .where(and(eq(localJobsTable.userId, userId), inArray(localJobsTable.status, OPEN)))
    .orderBy(asc(localJobsTable.createdAt), asc(localJobsTable.id));
}

/** Forma pubblica di un lavoro: mai l'hash del token né il prompt. */
export function toPublicJob(job: LocalJob) {
  return {
    id: job.id,
    kind: job.kind,
    analysisId: job.analysisId,
    runId: job.runId,
    machineId: job.machineId,
    status: job.status,
    origin: job.origin,
    claimedBy: job.claimedBy,
    fallbackAiModelId: job.fallbackAiModelId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
