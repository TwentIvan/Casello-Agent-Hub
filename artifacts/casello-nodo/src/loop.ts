import { CaselloClient, isLeaseLoss, leaseLossReason, type TaskPackage, type TaskReport } from "./client";
import { NODE_EXECUTOR, NODE_VERSION, scanFolders, scanSkills } from "./capabilities";
import { defaultPaths, type Config } from "./config";
import { createLogger, type Logger } from "./log";
import { isLeaseLostReport, killAllTaskGroups, runTask, WorkspaceQueue, type SpawnFn } from "./runner";
import { writeState, type NodeState } from "./state";

export interface LoopDeps {
  client?: CaselloClient;
  spawn?: SpawnFn;
  logger?: Logger;
  /** Cartella dei log se `logger` manca (default `~/.casello-nodo/logs`). */
  logsDir?: string;
  logToStdout?: boolean;
  /** File di stato letto da `casello-nodo status` (default `~/.casello-nodo/state.json`). */
  statePath?: string;
  heartbeatIntervalMs?: number;
  pingIntervalMs?: number;
  killGraceMs?: number;
  /** Attesa tra due tentativi di consegna del report (default 30 s). */
  reportRetryMs?: number;
}

export interface Loop {
  /** Ferma heartbeat e nuovi claim, interrompe i compiti in corso (report `failed`) e ne attende la chiusura. */
  stop(): Promise<void>;
  /** Errore fatale del processo: registra e termina subito (in modo sincrono) i gruppi dei compiti in corso. */
  crash(err: unknown): void;
}

const HEARTBEAT_MS = 30_000;
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
  let currentTick: Promise<void> | null = null;
  let stateWrite: Promise<void> = Promise.resolve();

  function saveState(): Promise<void> {
    state.updatedAt = new Date().toISOString();
    state.tasks = [...running].map(([taskId, t]) => ({ taskId, startedAt: t.startedAt.toISOString() }));
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
    try {
      let report: TaskReport;
      try {
        report = await runTask(pkg, {
          config,
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

  async function tick(): Promise<void> {
    try {
      const skills = await scanSkills(config.skillsDirs, logger);
      const { pending } = await client.heartbeat({
        version: NODE_VERSION,
        executor: NODE_EXECUTOR,
        skills,
        workspaceRoot: config.workspaceRoot.slice(0, WORKSPACE_ROOT_MAX),
        maxConcurrent: config.maxConcurrent,
        folders: await scanFolders(config.workspaceRoot),
      });
      state.lastHeartbeatAt = new Date().toISOString();
      let available = pending;
      while (!stopped && available > 0 && running.size < config.maxConcurrent) {
        const pkg = await client.claim();
        if (!pkg) break;
        available--;
        logger.info(`compito ${pkg.taskId} preso in carico (squadra ${pkg.team.id}, compito ${pkg.task.planTaskId})`);
        const entry = { startedAt: new Date(), promise: Promise.resolve() };
        running.set(pkg.taskId, entry);
        entry.promise = handleTask(pkg);
      }
    } catch (err) {
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

  logger.info(`nodo avviato (versione ${NODE_VERSION}, max ${config.maxConcurrent} compiti)`);
  schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopController.abort();
      if (currentTick) await currentTick;
      await Promise.all([...running.values()].map((t) => t.promise));
      await stateWrite;
      logger.info("nodo fermato");
    },
    crash(err) {
      stopped = true;
      if (timer) clearTimeout(timer);
      const killed = killAllTaskGroups();
      logger.error(`errore inatteso del nodo (${errorMessage(err)}): ${killed} compiti interrotti, esco`);
    },
  };
}
