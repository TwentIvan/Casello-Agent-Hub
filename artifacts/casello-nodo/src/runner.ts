import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeReportBody, nodeReportBodyDetailMax, nodeReportBodyOutcomeMax } from "@workspace/api-zod";
import { z } from "zod";
import {
  isLeaseLoss,
  LEASE_LOST,
  LeaseLostError,
  leaseLossReason,
  type CaselloClient,
  type TaskPackage,
  type TaskReport,
} from "./client";
import type { Config } from "./config";
import { GIT_MESSAGES, GitWorkspaceError } from "./git-errors";
import { locateGit } from "./git-check";
import { finishTaskRepo, prepareTaskRepo } from "./git-workspace";
import type { Logger } from "./log";
import { ATTACHMENTS_DIR, OUTCOME_FILE, renderTaskFile, TASK_FILE } from "./task-file";
import { isInside, resolveWorkspace, WORKSPACE_INVALID, WorkspaceError } from "./workspace";

export const PROMPT = "Leggi casello-compito.md in questa cartella ed eseguilo.";
export const TIMEOUT_OUTCOME = "tempo massimo superato";
export const ATTACHMENT_INVALID = "allegato non valido";
export const STOPPED_OUTCOME = "esecuzione interrotta: nodo fermato";

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface RunContext {
  config: Config;
  client: CaselloClient;
  spawn?: SpawnFn;
  logger?: Logger;
  /** Intervallo dei ping della lease (default 5 minuti). */
  pingIntervalMs?: number;
  /** Attesa tra SIGTERM e SIGKILL (default 10 s). */
  killGraceMs?: number;
  /** Attesa massima dello svuotamento di stdout dopo l'uscita di `claude` (default 3 s). */
  drainMs?: number;
  /** Chiamata a ogni lease rinnovata, con la nuova scadenza. */
  onLeaseRenewed?: (expiresAt: Date) => void;
  /** Stop del nodo: interrompe il compito (gruppo di processi terminato). */
  signal?: AbortSignal;
  /** Coda per spazio di lavoro condivisa tra i compiti del nodo (default: una per processo). */
  workspaceQueue?: WorkspaceQueue;
  /** Copia di lavoro Git dei compiti con codice (default: `prepareTaskRepo`/`finishTaskRepo`; i test la sostituiscono). */
  gitWorkspace?: GitWorkspace;
  /** Percorso di Git sul Mac, o null se manca (default: `locateGit`). */
  locateGit?: () => Promise<string | null>;
}

export interface GitWorkspace {
  prepare: typeof prepareTaskRepo;
  finish: typeof finishTaskRepo;
}

/** Esito scritto dall'operaio in `casello-esito.json` (stato dal contratto, testi troncati dopo). */
const OutcomeFile = z.object({
  status: NodeReportBody.shape.status,
  outcome: z.string().trim().min(1),
  detail: z.string().optional(),
});

/** Risultato JSON di `claude -p --output-format json` (solo i campi usati). */
export const CliResult = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .partial()
    .optional(),
});
export type CliResult = z.infer<typeof CliResult>;

const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const TOKENS_MAX = 2_000_000_000;
const COST_MAX = 100_000;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function permissionArgs(mode: string): string[] {
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode];
}

/**
 * Ambiente del processo figlio senza le variabili `CASELLO_*` (il token del nodo non passa all'operaio) né
 * `BOTCAVE_GIT_TOKEN` (il token per Git lo ricevono solo i processi `git` del nodo).
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CASELLO_") && k !== "BOTCAVE_GIT_TOKEN") env[k] = v;
  }
  return env;
}

class AttachmentError extends Error {
  constructor() {
    super(ATTACHMENT_INVALID);
  }
}

/** Scarica e verifica tutti gli allegati; scrive i file solo dopo che tutti sono stati verificati. */
async function fetchAttachments(pkg: TaskPackage, workspace: string, client: CaselloClient): Promise<void> {
  if (pkg.attachments.length === 0) return;
  const verified: Array<{ name: string; data: Buffer }> = [];
  const names = new Set<string>();
  for (const a of pkg.attachments) {
    const name = path.basename(a.name);
    if (!a.name || name !== a.name || name === "." || name === "..") throw new AttachmentError();
    // Due allegati con lo stesso nome si sovrascriverebbero
    // (il confronto ignora le maiuscole: APFS non le distingue)
    const key = name.toLowerCase();
    if (names.has(key)) throw new AttachmentError();
    names.add(key);
    let data: Buffer;
    try {
      data = await client.downloadAttachment(pkg.taskId, a.id, pkg.leaseToken);
    } catch (err) {
      if (isLeaseLoss(err)) throw new LeaseLostError();
      throw new AttachmentError();
    }
    const digest = createHash("sha256").update(data).digest("hex");
    if (data.length !== a.sizeBytes || digest !== a.sha256.toLowerCase()) throw new AttachmentError();
    verified.push({ name, data });
  }
  await mkdir(path.join(workspace, ATTACHMENTS_DIR), { recursive: true });
  // La cartella degli allegati non deve portare fuori dallo spazio di lavoro (link simbolico preesistente)
  const dir = await realpath(path.join(workspace, ATTACHMENTS_DIR));
  if (!isInside(workspace, dir)) throw new AttachmentError();
  for (const f of verified) {
    const target = path.join(dir, f.name);
    // Un file (o link) preesistente si toglie prima: `wx` non segue i link simbolici
    await rm(target, { force: true });
    await writeFile(target, f.data, { flag: "wx" });
  }
}

export interface ChildResult {
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | null;
  spawnFailed: boolean;
  stdout: string;
  /** Primi byte di stderr (solo se richiesto con `captureStderr`), per classificare gli errori. */
  stderr: string;
}

/** Segnale al gruppo di processi di `claude` (figli e nipoti compresi); in ripiego al solo figlio. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // processo già finito
    }
  }
}

/** Processi `claude` in corso in questo processo del nodo (per `killAllTaskGroups`). */
export const activeChildren = new Set<ChildProcess>();

/**
 * Uscita forzata del nodo (eccezione non gestita): SIGKILL subito, in modo sincrono, a tutti i gruppi di `claude` in
 * corso, perché nessun processo resti orfano a lavorare. Restituisce quanti gruppi ha terminato.
 */
export function killAllTaskGroups(): number {
  const children = [...activeChildren];
  for (const child of children) killGroup(child, "SIGKILL");
  activeChildren.clear();
  return children.length;
}

export interface SpawnGroupOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Testo scritto su stdin (poi chiuso); senza, stdin è ignorato. */
  stdin?: string;
  /** Tiene i primi 64 KB di stderr in `stderr` invece di scartarli. */
  captureStderr?: boolean;
  timeoutMs: number;
  killGraceMs?: number;
  drainMs?: number;
  spawn?: SpawnFn;
  logger?: Logger;
  signal: AbortSignal;
}

const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Lancia un processo in un gruppo proprio: al timeout o allo stop il gruppo riceve SIGTERM e, dopo l'attesa, SIGKILL.
 * Condiviso da compiti e turni.
 */
export function spawnGroup(o: SpawnGroupOptions): Promise<ChildResult> {
  const spawn = o.spawn ?? nodeSpawn;
  const killGraceMs = o.killGraceMs ?? 10_000;
  const drainMs = o.drainMs ?? 3_000;
  const signal = o.signal;

  return new Promise<ChildResult>((resolve) => {
    const result: ChildResult = {
      timedOut: false,
      aborted: false,
      exitCode: null,
      spawnFailed: false,
      stdout: "",
      stderr: "",
    };
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let settled = false;
    let started = false;
    let terminating = false;
    let drainTimer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      // Gruppo di processi proprio: al timeout o allo stop si termina anche ciò che `claude` ha lanciato
      child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: o.env ?? childEnv(),
        stdio: [o.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      resolve({ ...result, spawnFailed: true });
      return;
    }
    activeChildren.add(child);

    /** SIGTERM al gruppo, SIGKILL dopo l'attesa (il timer non trattiene il processo del nodo). */
    const terminateGroup = () => {
      if (terminating) return;
      terminating = true;
      killGroup(child, "SIGTERM");
      // Non si cancella all'uscita di `claude`: un nipote che ignora SIGTERM deve morire comunque (ESRCH ignorato)
      setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs).unref();
    };

    const timeout = setTimeout(() => {
      result.timedOut = true;
      terminateGroup();
    }, o.timeoutMs);

    const onAbort = () => {
      result.aborted = true;
      terminateGroup();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timeout);
      if (drainTimer) clearTimeout(drainTimer);
      signal.removeEventListener("abort", onAbort);
      result.stdout = Buffer.concat(chunks).toString("utf8");
      result.stderr = Buffer.concat(errChunks).toString("utf8");
      resolve(result);
    };

    child.stdout?.on("data", (c: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += c.length;
      chunks.push(c);
    });
    if (o.captureStderr) {
      child.stderr?.on("data", (c: Buffer) => {
        if (errSize >= MAX_STDERR_BYTES) return;
        errSize += c.length;
        errChunks.push(c);
      });
    } else {
      child.stderr?.resume();
    }
    if (o.stdin !== undefined && child.stdin) {
      // Un EPIPE (processo già uscito) non deve fermare il nodo
      child.stdin.on("error", () => {});
      child.stdin.end(o.stdin);
    }
    child.on("spawn", () => {
      started = true;
    });
    child.on("error", (err) => {
      if (!started) {
        // Errore prima dell'avvio (es. ENOENT): `claude` non avviabile
        result.spawnFailed = true;
        finish();
        return;
      }
      // Dopo l'avvio (es. kill non riuscito) decide l'uscita del processo
      o.logger?.warn(`Claude Code: errore del processo (${err.message})`);
    });
    child.on("exit", (code) => {
      result.exitCode = code;
      // Eventuali processi rimasti nel gruppo vengono chiusi
      terminateGroup();
      // Un nipote può tenere aperti i pipe: si aspetta poco, poi si chiudono
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, drainMs);
    });
    child.on("close", () => finish());
  });
}

async function runClaude(
  workspace: string,
  sessionId: string,
  ctx: RunContext,
  signal: AbortSignal,
): Promise<ChildResult> {
  return spawnGroup({
    command: ctx.config.claudeBin,
    args: ["-p", "--output-format", "json", "--session-id", sessionId, ...permissionArgs(ctx.config.permissionMode), PROMPT],
    cwd: workspace,
    timeoutMs: ctx.config.taskTimeoutMinutes * 60_000,
    killGraceMs: ctx.killGraceMs,
    drainMs: ctx.drainMs,
    spawn: ctx.spawn,
    logger: ctx.logger,
    signal,
  });
}

export function parseCli(stdout: string): CliResult | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = CliResult.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readOutcomeFile(workspace: string): Promise<z.infer<typeof OutcomeFile> | null> {
  try {
    const parsed = OutcomeFile.safeParse(JSON.parse(await readFile(path.join(workspace, OUTCOME_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function usageFields(cli: CliResult | null): Pick<TaskReport, "costUsd" | "promptTokens" | "completionTokens"> {
  const out: Pick<TaskReport, "costUsd" | "promptTokens" | "completionTokens"> = {};
  if (!cli) return out;
  const cost = cli.total_cost_usd;
  if (cost !== undefined && Number.isFinite(cost) && cost >= 0) out.costUsd = Math.min(cost, COST_MAX);
  const u = cli.usage;
  if (u) {
    const prompt = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (u.input_tokens !== undefined && Number.isFinite(prompt))
      out.promptTokens = Math.min(Math.max(0, Math.round(prompt)), TOKENS_MAX);
    if (u.output_tokens !== undefined && Number.isFinite(u.output_tokens)) {
      out.completionTokens = Math.min(Math.max(0, Math.round(u.output_tokens)), TOKENS_MAX);
    }
  }
  return out;
}

/**
 * Coda per spazio di lavoro: i compiti con lo stesso spazio (realpath) girano uno alla volta su questo nodo, perché
 * condividono `casello-compito.md` e `casello-esito.json`.
 */
export class WorkspaceQueue {
  private tails = new Map<string, Promise<void>>();

  /** Attende il proprio turno; restituisce la funzione che lo libera. Interrotta dal segnale → eccezione. */
  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("interrotto"));
        const onAbort = () => reject(new Error("interrotto"));
        signal.addEventListener("abort", onAbort, { once: true });
        void prev.then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }
}

const defaultQueue = new WorkspaceQueue();

/** Report di un compito la cui lease è persa: Casello lo rifiuterebbe (409), non si invia. */
export function isLeaseLostReport(report: TaskReport): boolean {
  return report.status === "failed" && report.outcome === LEASE_LOST;
}

type ReportFields = Omit<TaskReport, "leaseToken" | "sessionId">;

/** Note della copia di lavoro in fondo all'esito, « (<nota>)» ciascuna, entro i 300 caratteri dell'esito. */
export function withNotes(outcome: string, notes: readonly string[]): string {
  const suffix = notes.map((n) => ` (${n})`).join("");
  if (!suffix) return outcome;
  const room = nodeReportBodyOutcomeMax - suffix.length;
  return room >= 1 ? truncate(outcome, room) + suffix : truncate(outcome + suffix, nodeReportBodyOutcomeMax);
}

/** Esito di Claude Code dal file `casello-esito.json` o, in mancanza, dal JSON della CLI. */
async function claudeOutcome(child: ChildResult, cli: CliResult | null, workspace: string): Promise<ReportFields> {
  const usage = usageFields(cli);
  if (child.timedOut) return { status: "failed", outcome: TIMEOUT_OUTCOME, ...usage };
  if (child.spawnFailed) return { status: "failed", outcome: "Claude Code non avviabile" };

  const fromFile = await readOutcomeFile(workspace);
  if (fromFile) {
    return {
      status: fromFile.status,
      outcome: truncate(fromFile.outcome, nodeReportBodyOutcomeMax),
      ...(fromFile.detail ? { detail: truncate(fromFile.detail, nodeReportBodyDetailMax) } : {}),
      ...usage,
    };
  }
  if (!cli) {
    return { status: "failed", outcome: `Claude Code terminato senza esito (codice ${child.exitCode ?? "nessuno"})` };
  }
  const text = (cli.result ?? "").trim();
  if (cli.is_error) {
    return {
      status: "failed",
      outcome: truncate(text || "Claude Code ha restituito un errore", nodeReportBodyOutcomeMax),
      ...(text ? { detail: truncate(text, nodeReportBodyDetailMax) } : {}),
      ...usage,
    };
  }
  return {
    status: "done",
    outcome: truncate(text || "compito eseguito senza esito scritto", nodeReportBodyOutcomeMax),
    ...(text ? { detail: truncate(text, nodeReportBodyDetailMax) } : {}),
    ...usage,
  };
}

/** Dettaglio di un push non riuscito: l'esito di Claude Code, che altrimenti si perderebbe. */
function claudeDetail(r: ReportFields): string {
  const head = `Esito di Claude Code (${r.status}): ${r.outcome}`;
  return truncate(r.detail ? `${head}\n\n${r.detail}` : head, nodeReportBodyDetailMax);
}

/**
 * Esegue un compito del nodo con Claude Code e restituisce il report da inviare a Casello (validato con lo schema del
 * contratto). Non lancia eccezioni per gli esiti attesi: spazio di lavoro non valido → `blocked`, allegato non valido,
 * tempo massimo, lease persa, stop del nodo o errore della CLI → `failed`. La lease si rinnova dall'inizio (anche in
 * attesa dello spazio di lavoro e durante il download degli allegati); i file di servizio vengono rimossi alla fine.
 *
 * Compiti con codice (`pkg.git`, spec §4.3–§4.4): lo spazio di lavoro è la copia Git del compito che prepara Botcave (Git
 * mancante → `blocked` senza avviare Claude); dopo Claude, qualunque sia il suo esito, i commit nuovi si pubblicano e il
 * report porta `git`; push non riuscito → `failed` col messaggio fisso e l'esito di Claude nel dettaglio. Lease persa o
 * stop del nodo: nessuna pubblicazione, la copia resta per la ripresa.
 */
export async function runTask(pkg: TaskPackage, ctx: RunContext): Promise<TaskReport> {
  const sessionId = randomUUID();
  const base = { leaseToken: pkg.leaseToken, sessionId };
  const done = (r: ReportFields): TaskReport => NodeReportBody.parse({ ...base, ...r });
  const queue = ctx.workspaceQueue ?? defaultQueue;

  let workspace: string | null = null;
  let gitBin: string | null = null;
  if (pkg.git) {
    gitBin = await (ctx.locateGit ?? (() => locateGit()))().catch(() => null);
    if (gitBin === null) {
      ctx.logger?.warn(`compito ${pkg.taskId}: ${GIT_MESSAGES.notInstalled}`);
      return done({ status: "blocked", outcome: GIT_MESSAGES.notInstalled });
    }
  } else {
    try {
      workspace = await resolveWorkspace(ctx.config.workspaceRoot, pkg.workspace);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        ctx.logger?.warn(`compito ${pkg.taskId}: ${WORKSPACE_INVALID}`);
        return done({ status: "blocked", outcome: WORKSPACE_INVALID });
      }
      throw err;
    }
  }

  // Interruzione del compito: lease persa (ping con 409, 401 o 403: compito chiuso, token revocato, nodo disattivato)
  // o stop del nodo
  const control = new AbortController();
  let leaseLost = false;
  const onLeaseLost = (err: unknown) => {
    if (!leaseLost) ctx.logger?.warn(`compito ${pkg.taskId}: lease persa (${leaseLossReason(err)}), interrompo il compito`);
    leaseLost = true;
    control.abort();
  };
  const onStop = () => control.abort();
  if (ctx.signal?.aborted) control.abort();
  else ctx.signal?.addEventListener("abort", onStop, { once: true });
  const pinger = setInterval(
    () => {
      ctx.client.ping(pkg.taskId, pkg.leaseToken).then(
        (expiresAt) => ctx.onLeaseRenewed?.(expiresAt),
        (err: unknown) => {
          if (isLeaseLoss(err)) onLeaseLost(err);
          else ctx.logger?.warn(`compito ${pkg.taskId}: ping non riuscito (${(err as Error).message})`);
        },
      );
    },
    ctx.pingIntervalMs ?? 5 * 60_000,
  );
  const interrupted = () => done({ status: "failed", outcome: leaseLost ? LEASE_LOST : STOPPED_OUTCOME });
  /** Lease persa o nodo fermato (anche durante la preparazione o la pubblicazione). */
  const isInterrupted = (err?: unknown) => leaseLost || control.signal.aborted || err instanceof LeaseLostError;

  // Token per Git chiesto a ogni uso (prima e dopo Claude): resta solo in memoria, nell'ambiente dei processi `git`
  const getToken = async (): Promise<string> => {
    try {
      return await ctx.client.gitToken(pkg.taskId, pkg.leaseToken);
    } catch (err) {
      if (isLeaseLoss(err)) {
        onLeaseLost(err);
        throw new LeaseLostError();
      }
      if (err instanceof GitWorkspaceError) throw err;
      throw new GitWorkspaceError("failed", GIT_MESSAGES.unreachable);
    }
  };
  const gitWs = ctx.gitWorkspace ?? { prepare: prepareTaskRepo, finish: finishTaskRepo };
  const gitOptions =
    pkg.git && gitBin
      ? {
          root: ctx.config.workspaceRoot,
          git: pkg.git,
          getToken,
          queue,
          signal: control.signal,
          gitBin,
          logger: ctx.logger,
        }
      : null;
  const notes: string[] = [];

  let release: (() => void) | null = null;
  try {
    if (gitOptions) {
      try {
        const prepared = await gitWs.prepare(gitOptions);
        workspace = prepared.dir;
        if (prepared.note) notes.push(prepared.note);
      } catch (err) {
        if (isInterrupted(err)) return interrupted();
        if (err instanceof GitWorkspaceError) {
          ctx.logger?.warn(`compito ${pkg.taskId}: ${err.message}`);
          return done({ status: err.status, outcome: err.message });
        }
        throw err;
      }
    }
    if (workspace === null) throw new Error("spazio di lavoro assente");
    const ws = workspace;

    try {
      // Compiti con codice: la chiave è la cartella della copia del compito
      release = await queue.acquire(ws, control.signal);
    } catch {
      return interrupted();
    }

    try {
      await fetchAttachments(pkg, ws, ctx.client);
    } catch (err) {
      if (err instanceof AttachmentError || err instanceof LeaseLostError) {
        ctx.logger?.warn(`compito ${pkg.taskId}: ${err.message}`);
        return done({ status: "failed", outcome: err instanceof LeaseLostError ? err.message : ATTACHMENT_INVALID });
      }
      throw err;
    }
    if (control.signal.aborted) return interrupted();

    const taskFile = path.join(ws, TASK_FILE);
    await rm(path.join(ws, OUTCOME_FILE), { force: true });
    await rm(taskFile, { force: true });
    await writeFile(taskFile, renderTaskFile(pkg), { mode: 0o600, flag: "wx" });

    ctx.logger?.info(`compito ${pkg.taskId}: avvio Claude Code (sessione ${sessionId})`);
    const child = await runClaude(ws, sessionId, ctx, control.signal);
    const cli = parseCli(child.stdout);
    const usage = usageFields(cli);
    ctx.logger?.info(
      `compito ${pkg.taskId}: Claude Code terminato (codice ${child.exitCode ?? "nessuno"}${child.timedOut ? ", tempo massimo" : ""})`,
    );

    if (!child.timedOut && child.aborted) return { ...interrupted(), ...usage };
    const result = await claudeOutcome(child, cli, ws);
    if (!gitOptions) return done(result);

    // Dopo Claude: pubblicazione dei commit, salvo lease persa o nodo fermato (la copia resta)
    if (isInterrupted()) return { ...interrupted(), ...usage };
    let finished: Awaited<ReturnType<typeof finishTaskRepo>>;
    try {
      finished = await gitWs.finish({ ...gitOptions, dir: ws });
    } catch (err) {
      if (isInterrupted(err)) return { ...interrupted(), ...usage };
      if (err instanceof GitWorkspaceError) {
        ctx.logger?.warn(`compito ${pkg.taskId}: ${err.message}`);
        return done({ status: "failed", outcome: withNotes(err.message, notes), detail: claudeDetail(result), ...usage });
      }
      throw err;
    }
    if (finished.note) notes.push(finished.note);
    return done({
      ...result,
      outcome: withNotes(result.outcome, notes),
      git: { pushed: finished.pushed, headSha: finished.headSha, commits: finished.commits },
    });
  } finally {
    clearInterval(pinger);
    ctx.signal?.removeEventListener("abort", onStop);
    if (release && workspace !== null) {
      await rm(path.join(workspace, TASK_FILE), { force: true });
      await rm(path.join(workspace, OUTCOME_FILE), { force: true });
      release();
    }
  }
}
