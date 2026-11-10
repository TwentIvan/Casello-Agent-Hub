import {
  CaselloClient,
  HttpError,
  isLeaseLoss,
  leaseLossReason,
  type HeartbeatResult,
  type TaskPackage,
  type TaskReport,
} from "./client";
import { NODE_EXECUTOR, NODE_VERSION, scanFolders, scanSkills } from "./capabilities";
import { defaultPaths, type Config } from "./config";
import { createLogger, type Logger } from "./log";
import { realOsVersion, sendDiagnostics } from "./node-admin";
import { isLeaseLostReport, killAllTaskGroups, runTask, WorkspaceQueue, type SpawnFn } from "./runner";
import { startTurnLoop, type TurnLoop } from "./turns";
import { writeState, type NodeState } from "./state";
import {
  applyUpdate,
  fetchDownloader,
  isValidVersion,
  markUpdateHealthy,
  readFailedVersion,
  UPDATE_RETRY_MS,
  updatePaths,
  type Downloader,
  type UpdateInfo,
  type UpdatePaths,
} from "./updater";

/** Impostazioni dalla console (null = valore della config locale). */
export type NodeSettings = NonNullable<HeartbeatResult["settings"]>;
/** Come è installato il nodo: solo `app` si aggiorna da solo. */
export type NodeKind = "app" | "cli";

export interface LoopDeps {
  client?: CaselloClient;
  spawn?: SpawnFn;
  logger?: Logger;
  /** Cartella dei log se `logger` manca (default `~/.casello-nodo/logs`). */
  logsDir?: string;
  logToStdout?: boolean;
  /** Cartelle temporanee dei turni (default `~/.casello-nodo/turns`). */
  turnsDir?: string;
  /** Attesa dopo un errore del claim dei turni (default 5 s). */
  turnErrorWaitMs?: number;
  /** File di stato letto da `casello-nodo status` (default `~/.casello-nodo/state.json`). */
  statePath?: string;
  heartbeatIntervalMs?: number;
  pingIntervalMs?: number;
  killGraceMs?: number;
  turnPingIntervalMs?: number;
  /** Attesa tra due tentativi di consegna del report (default 30 s). */
  reportRetryMs?: number;
  /** `app` se il programma in esecuzione è `~/.casello-nodo/bin/casello-nodo` (default `cli`). */
  kind?: NodeKind;
  /** File dell'aggiornamento automatico (default sotto `~/.casello-nodo`). */
  updatePaths?: UpdatePaths;
  download?: Downloader;
  /** Uscita del processo dopo un aggiornamento (default `process.exit`). */
  exit?: (code: number) => void;
  now?: () => Date;
  /** Attesa tra due controlli durante il drenaggio del lavoro (iniettabile con un orologio finto). */
  sleep?: (ms: number) => Promise<void>;
  /** Intervallo dei controlli del drenaggio (default 1 s). */
  drainPollMs?: number;
  /** Notifica del Mac (solo modalità app). */
  notify?: (text: string) => Promise<void>;
  /** Stato di Claude Code per l'heartbeat e la diagnosi (lo riempie il Task 6); undefined = non mandato. */
  claudeStatus?: () => Promise<Record<string, unknown> | undefined>;
  /** Versione di macOS per la diagnosi (default `sw_vers -productVersion`). */
  osVersion?: () => Promise<string | null>;
  /** Disinstallazione chiesta dalla console: chiamata una volta sola (vedi `uninstallSelf`). */
  onUninstallRequested?: () => void;
}

export interface Loop {
  /** Ferma heartbeat e nuovi claim, interrompe compiti (report `failed`) e turni (report `stopped`) e ne attende la chiusura. */
  stop(): Promise<void>;
  /** Errore fatale del processo: registra e termina subito (in modo sincrono) i gruppi dei compiti in corso. */
  crash(err: unknown): void;
  /** Smette di prendere compiti e turni e aspetta quelli in corso; false se dopo `maxMs` c'è ancora lavoro. */
  drain(maxMs: number): Promise<boolean>;
  /** Riprende a prendere lavoro dopo un `drain`. */
  resume(): void;
  /**
   * Impostazioni dalla console, senza riavvio (null o campo null = config locale). Ridurre i posti non interrompe nulla:
   * si smette di prendere lavoro finché quello in corso non scende sotto il nuovo limite.
   */
  applySettings(settings: NodeSettings | null): void;
}

const HEARTBEAT_MS = 30_000;
export const UNAUTHORIZED_TEXT = "Botcave Nodo non è più collegato: aprilo e scegli Ricollega";
/** Dopo una diagnosi inviata si ignora per un minuto la stessa richiesta (heartbeat partito prima dell'invio). */
const DIAGNOSTICS_COOLDOWN_MS = 60_000;
const WORKSPACE_ROOT_MAX = 300;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ciclo del nodo: heartbeat ogni 30 s; se Casello ha compiti in attesa e c'è posto (`maxConcurrent`) li prende,
 * li esegue con Claude Code e ne riferisce l'esito (ritentato finché la lease è valida).
 */
export function startLoop(config: Config, deps: LoopDeps = {}): Loop {
  const paths = defaultPaths();
  const logger =
    deps.logger ??
    createLogger({ dir: deps.logsDir ?? paths.logsDir, stdout: deps.logToStdout, secrets: [config.token] });
  const client = deps.client ?? new CaselloClient({ baseUrl: config.caselloUrl, token: config.token });
  const statePath = deps.statePath ?? paths.statePath;
  const heartbeatMs = deps.heartbeatIntervalMs ?? HEARTBEAT_MS;
  const reportRetryMs = deps.reportRetryMs ?? 30_000;
  const kind: NodeKind = deps.kind ?? "cli";
  const updPaths = deps.updatePaths ?? updatePaths();
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const drainPollMs = deps.drainPollMs ?? 1_000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logsDir = deps.logsDir ?? paths.logsDir;
  // Valori in uso: config locale, sostituiti dalle impostazioni della console
  const effective = {
    maxConcurrent: config.maxConcurrent,
    maxConcurrentTurns: config.maxConcurrentTurns,
    taskTimeoutMinutes: config.taskTimeoutMinutes,
  };

  const running = new Map<number, { startedAt: Date; promise: Promise<void> }>();
  const state: NodeState = {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    tasks: [],
    lastError: null,
  };
  let stopped = false;
  // Lo stop interrompe i compiti in corso (gruppo di processi di `claude` terminato)
  const stopController = new AbortController();
  const workspaceQueue = new WorkspaceQueue();
  let timer: NodeJS.Timeout | undefined;
  let turnLoop: TurnLoop | null = null;
  let currentTick: Promise<void> | null = null;
  let stateWrite: Promise<void> = Promise.resolve();
  /** Nessun lavoro nuovo: aggiornamento in corso o disinstallazione. */
  let paused = false;
  let claimingTask = false;
  let healthyMarked = false;
  let unauthorizedNotified = false;
  let uninstalling = false;
  let diagnosticsInFlight = false;
  let diagnosticsSentAt = -Infinity;
  let updating = false;
  let updateApplied = false;
  let nextUpdateAt = -Infinity;
  let cliUpdateLogged = false;

  function saveState(): Promise<void> {
    state.updatedAt = new Date().toISOString();
    state.tasks = [...running].map(([taskId, t]) => ({ taskId, startedAt: t.startedAt.toISOString() }));
    state.turns = turnLoop?.running() ?? [];
    const snapshot = JSON.parse(JSON.stringify(state)) as NodeState;
    // Scritture in fila: l'ultima vince sempre
    stateWrite = stateWrite
      .then(() => writeState(statePath, snapshot))
      .catch((err: unknown) => logger.warn(`stato non scritto: ${errorMessage(err)}`));
    return stateWrite;
  }

  function recordError(message: string): void {
    state.lastError = message;
    logger.error(message);
  }

  async function deliverReport(pkg: TaskPackage, report: TaskReport, leaseExpiresAt: () => Date): Promise<void> {
    for (;;) {
      try {
        await client.report(pkg.taskId, report);
        logger.info(`compito ${pkg.taskId} riferito: ${report.status}`);
        return;
      } catch (err) {
        if (isLeaseLoss(err)) {
          logger.warn(`compito ${pkg.taskId}: report rifiutato, lease persa (${leaseLossReason(err)})`);
          return;
        }
        if (Date.now() >= leaseExpiresAt().getTime() || stopped) {
          recordError(
            `compito ${pkg.taskId}: report non consegnato prima della scadenza della lease (${errorMessage(err)})`,
          );
          return;
        }
        logger.warn(`compito ${pkg.taskId}: report non consegnato, nuovo tentativo (${errorMessage(err)})`);
        await new Promise((r) => setTimeout(r, reportRetryMs));
      }
    }
  }

  async function handleTask(pkg: TaskPackage): Promise<void> {
    let leaseExpiresAt = pkg.leaseExpiresAt;
    // Il timeout del compito è quello in vigore alla presa in carico
    const taskConfig: Config = { ...config, taskTimeoutMinutes: effective.taskTimeoutMinutes };
    try {
      let report: TaskReport;
      try {
        report = await runTask(pkg, {
          config: taskConfig,
          client,
          spawn: deps.spawn,
          logger,
          pingIntervalMs: deps.pingIntervalMs,
          killGraceMs: deps.killGraceMs,
          signal: stopController.signal,
          workspaceQueue,
          onLeaseRenewed: (d) => {
            leaseExpiresAt = d;
          },
        });
      } catch (err) {
        // Errore inatteso (es. file system): il compito non resta appeso fino alla scadenza della lease
        recordError(`compito ${pkg.taskId}: errore inatteso (${errorMessage(err)})`);
        report = { leaseToken: pkg.leaseToken, status: "failed", outcome: "errore del nodo durante l'esecuzione" };
      }
      if (isLeaseLostReport(report)) {
        logger.warn(`compito ${pkg.taskId}: lease persa, nessun report`);
      } else {
        await deliverReport(pkg, report, () => leaseExpiresAt);
      }
    } catch (err) {
      recordError(`compito ${pkg.taskId}: errore inatteso (${errorMessage(err)})`);
    } finally {
      running.delete(pkg.taskId);
      await saveState();
    }
  }

  function applySettings(settings: NodeSettings | null): void {
    const next = {
      maxConcurrent: settings?.maxConcurrent ?? config.maxConcurrent,
      maxConcurrentTurns: settings?.maxConcurrentTurns ?? config.maxConcurrentTurns,
      taskTimeoutMinutes: settings?.taskTimeoutMinutes ?? config.taskTimeoutMinutes,
    };
    if (
      next.maxConcurrent !== effective.maxConcurrent ||
      next.maxConcurrentTurns !== effective.maxConcurrentTurns ||
      next.taskTimeoutMinutes !== effective.taskTimeoutMinutes
    ) {
      logger.info(
        `impostazioni: ${next.maxConcurrent} compiti, ${next.maxConcurrentTurns} turni, timeout ${next.taskTimeoutMinutes} minuti`,
      );
    }
    Object.assign(effective, next);
    turnLoop?.setMaxTurns(next.maxConcurrentTurns);
  }

  function pauseWork(): void {
    paused = true;
    turnLoop?.pause();
  }

  function resume(): void {
    if (stopped || uninstalling) return;
    paused = false;
    turnLoop?.resume();
  }

  async function drain(maxMs: number): Promise<boolean> {
    pauseWork();
    const start = now().getTime();
    for (;;) {
      if (running.size === 0 && !claimingTask && (turnLoop?.idle() ?? true)) return true;
      if (now().getTime() - start >= maxMs) return false;
      await sleep(drainPollMs);
    }
  }

  function requestDiagnostics(): void {
    if (diagnosticsInFlight || now().getTime() - diagnosticsSentAt < DIAGNOSTICS_COOLDOWN_MS) return;
    diagnosticsInFlight = true;
    void sendDiagnostics({
      paths: { ...paths, logsDir, statePath },
      config,
      version: NODE_VERSION,
      osVersion: deps.osVersion ?? realOsVersion,
      claudeStatus: async () => deps.claudeStatus?.(),
      send: (content) => client.uploadDiagnostics(content),
    })
      .then(() => {
        diagnosticsSentAt = now().getTime();
        logger.info("diagnosi inviata");
      })
      .catch((err: unknown) => logger.warn(`diagnosi non inviata (${errorMessage(err)})`))
      .finally(() => {
        diagnosticsInFlight = false;
      });
  }

  function requestUninstall(): void {
    if (uninstalling) return;
    uninstalling = true;
    pauseWork();
    logger.info("disinstallazione chiesta dalla console");
    if (deps.onUninstallRequested) deps.onUninstallRequested();
    else logger.warn("disinstallazione non disponibile in questa modalità");
  }

  function maybeUpdate(update: UpdateInfo): void {
    if (kind !== "app") {
      // Server vecchio o errato: un nodo installato con la CLI non si aggiorna da solo
      if (!cliUpdateLogged) logger.info("aggiornamento disponibile ignorato: nodo installato con la CLI");
      cliUpdateLogged = true;
      return;
    }
    if (updating || updateApplied || uninstalling || stopped) return;
    if (update.version === readFailedVersion(updPaths)) return;
    if (now().getTime() < nextUpdateAt) return;
    // Non obbligatorio: si aspetta che il nodo sia libero, senza scaricare nulla
    if (!update.required && (running.size > 0 || (turnLoop?.activeCount() ?? 0) > 0)) return;
    const label = isValidVersion(update.version) ? update.version : "?";
    updating = true;
    // Da qui niente lavoro nuovo: il download è breve e poi si sostituisce il programma
    pauseWork();
    logger.info(`aggiornamento a ${label}${update.required ? " (obbligatorio)" : ""}: download`);
    void applyUpdate(update, {
      caselloUrl: config.caselloUrl,
      currentVersion: NODE_VERSION,
      paths: updPaths,
      download: deps.download ?? fetchDownloader(),
      drain,
      interrupt: async () => {
        logger.warn("aggiornamento obbligatorio: lavoro ancora in corso dopo 30 minuti, lo interrompo");
        await stop();
      },
      resume,
      exit: (code) => {
        updateApplied = true;
        logger.info(code === 0 ? `aggiornamento a ${label} installato: riavvio` : "aggiornamento non riuscito: riavvio");
        exit(code);
      },
      now,
    })
      .catch((err: unknown) => {
        nextUpdateAt = now().getTime() + UPDATE_RETRY_MS;
        logger.warn(`aggiornamento a ${label} non riuscito (${errorMessage(err)}): nuovo tentativo tra un'ora`);
        resume();
      })
      .finally(() => {
        updating = false;
      });
  }

  function notifyUnauthorized(): void {
    if (unauthorizedNotified) return;
    unauthorizedNotified = true;
    void deps.notify?.(UNAUTHORIZED_TEXT).catch(() => {});
  }

  async function tick(): Promise<void> {
    try {
      const skills = await scanSkills(config.skillsDirs, logger);
      const claude = await deps.claudeStatus?.().catch(() => undefined);
      const updateFailed = readFailedVersion(updPaths);
      const hb = await client.heartbeat({
        version: NODE_VERSION,
        executor: NODE_EXECUTOR,
        skills,
        workspaceRoot: config.workspaceRoot.slice(0, WORKSPACE_ROOT_MAX),
        maxConcurrent: effective.maxConcurrent,
        folders: await scanFolders(config.workspaceRoot),
        kind,
        ...(claude ? { claude } : {}),
        ...(updateFailed ? { updateFailed } : {}),
      });
      state.lastHeartbeatAt = new Date().toISOString();
      unauthorizedNotified = false;
      if (!healthyMarked) {
        // Primo heartbeat riuscito: un aggiornamento appena installato funziona, niente ritorno indietro
        markUpdateHealthy(updPaths);
        healthyMarked = true;
      }
      applySettings(hb.settings ?? null);
      if (hb.uninstallRequested) requestUninstall();
      if (hb.diagnosticsRequested) requestDiagnostics();
      let available = hb.pending;
      while (!stopped && !paused && available > 0 && running.size < effective.maxConcurrent) {
        let pkg: TaskPackage | null;
        claimingTask = true;
        try {
          pkg = await client.claim();
        } finally {
          claimingTask = false;
        }
        if (!pkg) break;
        available--;
        logger.info(`compito ${pkg.taskId} preso in carico (squadra ${pkg.team.id}, compito ${pkg.task.planTaskId})`);
        const entry = { startedAt: new Date(), promise: Promise.resolve() };
        running.set(pkg.taskId, entry);
        entry.promise = handleTask(pkg);
      }
      // Dopo i claim: un aggiornamento non obbligatorio aspetta il lavoro appena preso
      if (hb.update) maybeUpdate(hb.update);
    } catch (err) {
      if (kind === "app" && err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        // Token revocato o nodo disattivato: nessun lavoro, nuovo tentativo al prossimo heartbeat, mai un'uscita
        // (launchd riavvierebbe il processo in ciclo)
        notifyUnauthorized();
      }
      recordError(`ciclo: ${errorMessage(err)}`);
    }
    await saveState();
  }

  function schedule(delay: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      currentTick = tick().finally(() => {
        currentTick = null;
        schedule(heartbeatMs);
      });
    }, delay);
  }

  logger.info(
    `nodo avviato (versione ${NODE_VERSION}, ${kind}, max ${config.maxConcurrent} compiti, ${config.maxConcurrentTurns} turni)`,
  );
  schedule(0);
  turnLoop = startTurnLoop({
    config,
    client,
    logger,
    turnsDir: deps.turnsDir ?? paths.turnsDir,
    spawn: deps.spawn,
    errorWaitMs: deps.turnErrorWaitMs,
    pingIntervalMs: deps.turnPingIntervalMs,
    killGraceMs: deps.killGraceMs,
    onChange: () => void saveState(),
  });

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopController.abort();
    if (currentTick) await currentTick;
    await Promise.all([...[...running.values()].map((t) => t.promise), turnLoop?.stop()]);
    await stateWrite;
    logger.info("nodo fermato");
  }

  return {
    stop,
    drain,
    resume,
    applySettings,
    crash(err) {
      stopped = true;
      if (timer) clearTimeout(timer);
      const killed = killAllTaskGroups();
      logger.error(`errore inatteso del nodo (${errorMessage(err)}): ${killed} compiti interrotti, esco`);
    },
  };
}
