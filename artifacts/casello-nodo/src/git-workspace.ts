import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TaskPackage } from "./client";
import { GIT_MESSAGES, GitWorkspaceError } from "./git-errors";
import type { Logger } from "./log";
import { childEnv, spawnGroup, type ChildResult, type SpawnFn, type WorkspaceQueue } from "./runner";
import { ATTACHMENTS_DIR, OUTCOME_FILE, TASK_FILE } from "./task-file";
import { isInside } from "./workspace";

export { GIT_MESSAGES, GitWorkspaceError };

/** Repository, base e branch del compito (dal pacchetto). */
export type NodeTaskGit = NonNullable<TaskPackage["git"]>;

const NETWORK_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 60_000;
const BRANCH_PREFIX = "botcave/";
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BASE_RE = /^[A-Za-z0-9._/-]{1,255}$/;
const DIVERGED_NOTE = "commit locali non pubblicati scartati: il branch era cambiato su GitHub";
const SERVICE_ENTRIES = [TASK_FILE, OUTCOME_FILE, `${ATTACHMENTS_DIR}/`];
/** Ogni comando: niente hook (un hook scritto nella copia girerebbe col token nell'ambiente) né fsmonitor. */
const SAFE_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
/** Variabili ereditate che cambierebbero repository, credenziali o tracce di `git`. */
const INHERITED_GIT_VARS =
  /^(GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|ASKPASS|SSH|SSH_COMMAND|PROXY_COMMAND|TRACE\w*)|SSH_ASKPASS|BOTCAVE_GIT_TOKEN)$/;
/**
 * Configurazione locale che dirotterebbe il token (riscrittura dell'indirizzo, helper, proxy, include): Claude può scriverla
 * nella copia di lavoro. Con una di queste chiavi i comandi di rete non partono.
 */
const UNSAFE_CONFIG =
  /^(url\.|credential\b|http\.|include\.|includeif\.|core\.(askpass|sshcommand|gitproxy)|remote\.[^\n]*\.(proxy|pushurl)$)/i;

/**
 * Ambiente dei processi `git` (spec §4.2): prompt spenti, helper delle credenziali azzerati (il portachiavi del Mac non salva
 * il token) e, con il token, un helper che lo legge da `BOTCAVE_GIT_TOKEN`. Il token non va mai negli argomenti.
 */
export function gitEnv(token: string | null): NodeJS.ProcessEnv {
  const env = childEnv();
  for (const k of Object.keys(env)) if (INHERITED_GIT_VARS.test(k)) delete env[k];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.GIT_CONFIG_KEY_0 = "credential.helper";
  env.GIT_CONFIG_VALUE_0 = "";
  if (token === null) {
    env.GIT_CONFIG_COUNT = "1";
    return env;
  }
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_1 = "credential.helper";
  env.GIT_CONFIG_VALUE_1 = '!f() { echo username=x-access-token; echo "password=$BOTCAVE_GIT_TOKEN"; }; f';
  env.BOTCAVE_GIT_TOKEN = token;
  return env;
}

/** Messaggio fisso per uno stderr di `git` (mai inoltrato). */
export function classifyGitError(stderr: string, phase: "fetch" | "push"): string {
  const network = /Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Operation timed out|returned error: 5\d\d|unable to access/i;
  if (phase === "fetch") {
    if (/Authentication failed|Repository not found|returned error: 40[134]/i.test(stderr)) return GIT_MESSAGES.noAccess;
    return GIT_MESSAGES.unreachable;
  }
  if (/remote rejected|pre-receive hook declined|GH\d{3}/i.test(stderr)) return GIT_MESSAGES.pushRefused;
  if (/non-fast-forward|\[rejected\]|fetch first/i.test(stderr)) return GIT_MESSAGES.pushChanged;
  if (network.test(stderr)) return GIT_MESSAGES.pushRetry;
  return GIT_MESSAGES.pushRetry;
}

interface CommonOptions {
  root: string;
  git: NodeTaskGit;
  getToken: () => Promise<string>;
  queue: WorkspaceQueue;
  signal: AbortSignal;
  /** Al posto di `https://github.com/<repo>.git` (solo test). */
  remoteUrl?: string;
  gitBin?: string;
  spawn?: SpawnFn;
  logger?: Logger;
}

export interface PrepareResult {
  dir: string;
  resumed: boolean;
  note: string | null;
}

export interface FinishResult {
  pushed: boolean;
  headSha: string | null;
  commits: number;
  note: string | null;
}

const failed = (message: string = GIT_MESSAGES.prepareFailed) => new GitWorkspaceError("failed", message);
const ok = (r: ChildResult) => !r.spawnFailed && !r.timedOut && !r.aborted && r.exitCode === 0;

/** Proprietario, nome, branch del compito (`botcave/<nome>`, diverso dal base) e base validati prima di ogni comando. */
function validate(g: NodeTaskGit): { owner: string; name: string; slot: string } {
  const parts = g.repo.split("/");
  const valid = (s: string) => NAME_RE.test(s) && s !== "." && s !== "..";
  const slot = g.branch.startsWith(BRANCH_PREFIX) ? g.branch.slice(BRANCH_PREFIX.length) : "";
  const base = g.baseBranch;
  const baseOk =
    BASE_RE.test(base) && !base.startsWith("-") && !base.startsWith("/") && !base.endsWith("/") && !base.includes("..") &&
    !base.includes("//") && !base.endsWith(".lock");
  if (parts.length !== 2 || !parts.every(valid) || !valid(slot) || !baseOk || g.branch === base) throw failed();
  return { owner: parts[0], name: parts[1], slot };
}

/** Cartelle del clone e della copia, dentro la radice anche risolti i link simbolici. */
async function locate(root: string, g: NodeTaskGit): Promise<{ clone: string; dir: string; tasks: string }> {
  const { owner, name, slot } = validate(g);
  try {
    const realRoot = await realpath(root);
    const ownerDir = path.join(realRoot, ".botcave", "repos", owner);
    const tasksDir = path.join(realRoot, ".botcave", "compiti");
    await mkdir(ownerDir, { recursive: true });
    await mkdir(tasksDir, { recursive: true });
    const [realOwner, realTasks] = await Promise.all([realpath(ownerDir), realpath(tasksDir)]);
    if (!isInside(realRoot, realOwner) || !isInside(realRoot, realTasks)) throw failed();
    const clone = path.join(realOwner, `${name}.git`);
    const dir = path.join(realTasks, slot);
    // Un link simbolico al posto del clone o della copia porterebbe fuori dalla radice: si toglie (solo il link)
    for (const p of [clone, dir]) if ((await lstat(p).catch(() => null))?.isSymbolicLink()) await rm(p);
    return { clone, dir, tasks: realTasks };
  } catch (err) {
    throw err instanceof GitWorkspaceError ? err : failed();
  }
}

function makeRunner(o: CommonOptions) {
  return (args: string[], cwd: string, token: string | null = null): Promise<ChildResult> =>
    spawnGroup({
      command: o.gitBin ?? "git",
      args: [...SAFE_ARGS, ...args],
      cwd,
      env: gitEnv(token),
      captureStderr: true,
      timeoutMs: token === null ? LOCAL_TIMEOUT_MS : NETWORK_TIMEOUT_MS,
      spawn: o.spawn,
      logger: o.logger,
      signal: o.signal,
    });
}

type Run = ReturnType<typeof makeRunner>;

async function out(run: Run, args: string[], cwd: string): Promise<string> {
  const r = await run(args, cwd);
  if (!ok(r)) throw failed();
  return r.stdout.trim();
}

const refExists = async (run: Run, cwd: string, ref: string) =>
  ok(await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd));

/** Rifiuta i comandi di rete se la configurazione locale (o della copia) potrebbe dirottare il token. */
async function assertSafeConfig(run: Run, cwd: string): Promise<void> {
  const list = async (scope: string) => (await out(run, ["config", scope, "--name-only", "--list", "-z"], cwd)).split("\0");
  const keys = await list("--local");
  // La configurazione per copia (`config.worktree`) esiste solo con l'estensione attiva; senza, `--worktree` fallisce
  if (keys.some((k) => k.toLowerCase() === "extensions.worktreeconfig")) keys.push(...(await list("--worktree")));
  if (keys.some((k) => k !== "" && UNSAFE_CONFIG.test(k))) throw failed();
}

async function acquire(o: CommonOptions, key: string): Promise<() => void> {
  try {
    return await o.queue.acquire(key, o.signal);
  } catch {
    throw failed();
  }
}

/** La cartella è una copia di lavoro di questo clone, sul branch del compito. */
async function isTaskWorktree(run: Run, dir: string, clone: string, branch: string): Promise<boolean> {
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) return false;
  const top = await run(["rev-parse", "--show-toplevel", "--git-common-dir"], dir);
  if (!ok(top)) return false;
  const [toplevel, common] = top.stdout.trim().split("\n");
  const realCommon = await realpath(path.resolve(dir, common ?? "")).catch(() => null);
  if (realCommon !== clone || (await realpath(toplevel).catch(() => null)) !== dir) return false;
  const head = await run(["symbolic-ref", "-q", "HEAD"], dir);
  return ok(head) && head.stdout.trim() === `refs/heads/${branch}`;
}

/** Toglie la copia (anche una cartella non valida) e ripulisce le copie registrate che non esistono più. */
async function removeWorktree(run: Run, clone: string, dir: string): Promise<void> {
  if (existsSync(dir)) await run(["worktree", "remove", "--force", dir], clone);
  await rm(dir, { recursive: true, force: true });
  await run(["worktree", "prune"], clone);
}

/** Clone nudo se manca (una cartella incompleta si rifà), altrimenti fetch; refs remoti in `refs/remotes/origin/*`. */
async function syncClone(run: Run, clone: string, url: string, token: string): Promise<void> {
  const valid =
    existsSync(path.join(clone, "HEAD")) && (await run(["rev-parse", "--is-bare-repository"], clone)).stdout.trim() === "true";
  if (!valid) {
    await rm(clone, { recursive: true, force: true });
    await out(run, ["init", "-q", "--bare", clone], path.dirname(clone));
    await out(run, ["remote", "add", "origin", url], clone);
  }
  await assertSafeConfig(run, clone);
  // Indirizzo esplicito: `remote.origin.url` modificato nella copia non conta
  const r = await run(["fetch", "--prune", "--no-tags", url, "+refs/heads/*:refs/remotes/origin/*"], clone, token);
  if (!ok(r)) {
    if (!valid) await rm(clone, { recursive: true, force: true });
    throw failed(classifyGitError(r.stderr, "fetch"));
  }
}

/** File di servizio del compito in `info/exclude` del clone (vale per tutte le copie), una volta sola. */
async function addExcludes(clone: string): Promise<void> {
  const file = path.join(clone, "info", "exclude");
  await mkdir(path.dirname(file), { recursive: true });
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) await rm(file);
  const current = await readFile(file, "utf8").catch(() => "");
  const lines = current.split("\n");
  const missing = SERVICE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(file, current + sep + missing.join("\n") + "\n");
}

/**
 * Prima di Claude (spec §4.3): Git presente, token, clone o fetch sotto il lock del repository, copia di lavoro del compito
 * ripresa o creata con `worktree add`. Errori: `GitWorkspaceError` (messaggi fissi) o perdita della lease da `getToken`.
 */
export async function prepareTaskRepo(o: CommonOptions): Promise<PrepareResult> {
  const { clone, dir } = await locate(o.root, o.git);
  const run = makeRunner(o);
  const version = await run(["--version"], o.root);
  if (!ok(version) && !o.signal.aborted) throw new GitWorkspaceError("blocked", GIT_MESSAGES.notInstalled);
  const token = await o.getToken();
  const url = o.remoteUrl ?? `https://github.com/${o.git.repo}.git`;
  const { branch, baseBranch } = o.git;
  const release = await acquire(o, clone);
  try {
    await syncClone(run, clone, url, token);
    await addExcludes(clone);
    const originBranch = `refs/remotes/origin/${branch}`;
    const hasBranch = await refExists(run, clone, originBranch);
    let note: string | null = null;
    if (await isTaskWorktree(run, dir, clone, branch)) {
      if (!hasBranch || ok(await run(["merge-base", "--is-ancestor", originBranch, "HEAD"], dir))) {
        o.logger?.info(`Git: copia del compito ${branch} ripresa`);
        return { dir, resumed: true, note: null };
      }
      note = DIVERGED_NOTE;
    }
    await removeWorktree(run, clone, dir);
    const start = hasBranch ? originBranch : `refs/remotes/origin/${baseBranch}`;
    if (!hasBranch && !(await refExists(run, clone, start))) throw failed(GIT_MESSAGES.baseMissing);
    await out(run, ["worktree", "add", "-q", "--no-track", "-B", branch, dir, start], clone);
    o.logger?.info(`Git: copia del compito ${branch} creata`);
    return { dir, resumed: false, note };
  } catch (err) {
    throw err instanceof GitWorkspaceError ? err : failed();
  } finally {
    release();
  }
}

/** File modificati o nuovi non committati, esclusi quelli di servizio. */
async function countDirty(run: Run, dir: string): Promise<number> {
  const entries = (await out(run, ["status", "--porcelain", "-z", "--untracked-files=all"], dir)).split("\0");
  let n = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    if (e[0] === "R" || e[0] === "C") i++; // percorso d'origine della rinomina
    const file = e.slice(3);
    if (file === TASK_FILE || file === OUTCOME_FILE || file.startsWith(`${ATTACHMENTS_DIR}/`)) continue;
    n++;
  }
  return n;
}

/**
 * Dopo Claude (spec §4.4): conta i commit nuovi, li pubblica con `push HEAD:refs/heads/<branch>` (mai `--force`, solo
 * `botcave/…` diverso dal base) e toglie la copia. Push fallito → `GitWorkspaceError` e copia lasciata per la ripresa.
 */
export async function finishTaskRepo(o: CommonOptions & { dir: string }): Promise<FinishResult> {
  const { clone, tasks } = await locate(o.root, o.git);
  const run = makeRunner(o);
  const { branch, baseBranch } = o.git;
  const dir = await realpath(o.dir).catch(() => null);
  if (dir === null || !isInside(tasks, dir) || dir === tasks || !(await isTaskWorktree(run, dir, clone, branch))) {
    const release = await acquire(o, clone);
    await run(["worktree", "prune"], clone).finally(release);
    return { pushed: false, headSha: null, commits: 0, note: null };
  }
  const originBranch = `refs/remotes/origin/${branch}`;
  const from = (await refExists(run, clone, originBranch)) ? originBranch : `refs/remotes/origin/${baseBranch}`;
  if (!(await refExists(run, clone, from))) throw failed(GIT_MESSAGES.baseMissing);
  const commits = Number(await out(run, ["rev-list", "--count", `${from}..HEAD`], dir));
  let headSha: string | null = null;
  if (commits > 0) {
    const token = await o.getToken();
    const url = o.remoteUrl ?? `https://github.com/${o.git.repo}.git`;
    const release = await acquire(o, clone);
    try {
      await assertSafeConfig(run, dir);
      const r = await run(["push", "--no-verify", url, `HEAD:refs/heads/${branch}`], dir, token);
      if (!ok(r)) throw failed(classifyGitError(r.stderr, "push"));
    } finally {
      release();
    }
    headSha = await out(run, ["rev-parse", "HEAD"], dir);
    o.logger?.info(`Git: compito ${branch}, ${commits} commit pubblicati`);
  }
  const dirty = await countDirty(run, dir);
  const release = await acquire(o, clone);
  try {
    await removeWorktree(run, clone, dir);
    await run(["branch", "-D", branch], clone);
  } finally {
    release();
  }
  return {
    pushed: commits > 0,
    headSha,
    commits,
    note: dirty > 0 ? `modifiche non committate scartate: ${dirty} file` : null,
  };
}
