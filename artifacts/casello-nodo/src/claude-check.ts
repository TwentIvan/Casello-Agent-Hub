import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs";
import path from "node:path";

/** Indirizzo dell'installatore ufficiale di Claude Code: costante nel codice, mai dal server. */
export const CLAUDE_INSTALL_URL = "https://claude.ai/install.sh";
const CHECK_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 600_000;
const LOGIN_POLL_MS = 5_000;
const LOGIN_MAX_MS = 600_000;
const STATUS_TTL_MS = 600_000;

/** Stato mandato nell'heartbeat: mai email né dati dell'organizzazione. */
export type ClaudeStatus = {
  found: boolean;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  loginExpiresAt?: string;
};

/** Esegue un comando: stdout, oppure null se fallisce o supera il tempo. */
export type RunFn = (file: string, args: string[], timeoutMs: number) => Promise<string | null>;

export interface ClaudeDeps {
  /** Percorso di `claude` o null. */
  which: () => Promise<string | null>;
  run: RunFn;
  home: string;
}

function isExecutable(p: string): Promise<boolean> {
  return new Promise((resolve) => access(p, constants.X_OK, (err) => resolve(!err)));
}

/** Cerca `claude` nel PATH e in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` (l'app da Finder ha un PATH minimo). */
export async function locateClaude(o: {
  pathEnv: string | undefined;
  home: string;
  /** Cartelle dopo il PATH (default quelle consuete). */
  extraDirs?: string[];
}): Promise<string | null> {
  const extra = o.extraDirs ?? [path.join(o.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = [...(o.pathEnv ?? "").split(path.delimiter).filter((d) => d.startsWith("/")), ...extra];
  for (const dir of dirs) {
    const candidate = path.join(dir, "claude");
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export function realRun(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

export function realClaudeDeps(home: string): ClaudeDeps {
  return { which: () => locateClaude({ pathEnv: process.env.PATH, home }), run: realRun, home };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 100) : undefined;
}

/** Verifica di Claude Code: presenza, versione e accesso. Non lancia mai. */
export async function checkClaude(d: ClaudeDeps): Promise<ClaudeStatus> {
  const bin = await d.which().catch(() => null);
  if (!bin) return { found: false };
  const status: ClaudeStatus = { found: true };
  const version = (await d.run(bin, ["--version"], CHECK_TIMEOUT_MS).catch(() => null))?.trim().split(/\s+/)[0];
  if (version) status.version = version.slice(0, 100);
  const raw = await d.run(bin, ["auth", "status", "--json"], CHECK_TIMEOUT_MS).catch(() => null);
  if (raw) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (typeof j.loggedIn === "boolean") {
        status.loggedIn = j.loggedIn;
        const authMethod = str(j.authMethod);
        const subscriptionType = str(j.subscriptionType);
        const loginExpiresAt = str(j.loginExpiresAt);
        if (authMethod) status.authMethod = authMethod;
        if (subscriptionType) status.subscriptionType = subscriptionType;
        if (loginExpiresAt) status.loginExpiresAt = loginExpiresAt;
      }
    } catch {
      // JSON non valido: loggedIn resta assente (e il contenuto non si registra)
    }
  }
  return status;
}

/** Riusa l'ultimo risultato per 10 minuti: l'heartbeat è ogni 30 s ma `claude` non si lancia a ogni giro. */
export function createCachedClaudeStatus(
  check: () => Promise<ClaudeStatus>,
  now: () => number = Date.now,
  ttlMs = STATUS_TTL_MS,
): () => Promise<ClaudeStatus> {
  let last: { at: number; status: ClaudeStatus } | null = null;
  return async () => {
    if (!last || now() - last.at >= ttlMs) last = { at: now(), status: await check() };
    return last.status;
  };
}

export type ExecLongFn = (file: string, args: string[], timeoutMs: number) => Promise<void>;

export function realExec(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err) => (err ? reject(new Error("comando non riuscito")) : resolve()));
  });
}

/** Installazione con l'installatore ufficiale (10 minuti al massimo), poi verifica. */
export async function installClaude(d: ClaudeDeps & { exec?: ExecLongFn }): Promise<ClaudeStatus> {
  const exec = d.exec ?? realExec;
  await exec("/bin/bash", ["-c", `curl -fsSL ${CLAUDE_INSTALL_URL} | bash`], INSTALL_TIMEOUT_MS).catch(() => {});
  return checkClaude(d);
}

/** `claude auth login` staccato: apre il login nel browser e non lega il suo ciclo di vita al nostro. */
export function realSpawnLogin(bin: string): void {
  const child = spawn(bin, ["auth", "login"], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/** Lancia il login e verifica ogni 5 s per al più 10 minuti; true se l'accesso risulta fatto. */
export async function loginClaude(
  d: ClaudeDeps & {
    spawnLogin?: (bin: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<boolean> {
  const bin = await d.which();
  if (!bin) return false;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  (d.spawnLogin ?? realSpawnLogin)(bin);
  const start = now();
  while (now() - start < LOGIN_MAX_MS) {
    if ((await checkClaude(d)).loggedIn === true) return true;
    await sleep(LOGIN_POLL_MS);
  }
  return false;
}
