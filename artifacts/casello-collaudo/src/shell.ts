// Comandi `shell` del collaudatore: `bash -lc` dentro la copia del repository, con tempo massimo e uscita tagliata.
// I processi partono in un gruppo proprio (si terminano tutti insieme); quelli in background restano accesi fino a
// `stopBackground`. L'ambiente non porta mai il codice monouso né variabili con token o segreti del runner.

import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_OUTPUT = 8_000;
export const MAX_TIMEOUT_SEC = 300;
export const DEFAULT_TIMEOUT_SEC = 120;
const KILL_GRACE_MS = 5_000;
const BACKGROUND_WAIT_MS = 5_000;
/** Memoria tenuta per l'uscita di un comando: oltre si conserva la coda. */
const KEEP_CHARS = 64_000;
const BACKGROUND_HEAD_CHARS = 4_000;

export type ShellCommand = { command: string; cwd?: string; timeoutSec?: number; background?: boolean };
export type ShellResult = { ok: boolean; output: string };
export type ShellOptions = { env?: Record<string, string>; backgroundWaitMs?: number };

export const SHELL_MESSAGES = {
  invalid: "argomenti non validi: serve command (testo)",
  cwdOutside: "cartella non valida: deve stare dentro il repository",
  timeout: (sec: number) => `tempo scaduto dopo ${sec} s: comando terminato`,
  exitCode: (code: number | null, signal: string | null) =>
    signal ? `(terminato dal segnale ${signal})` : `(uscito con codice ${code ?? "sconosciuto"})`,
  spawnFailed: "comando non avviato",
  truncated: "[uscita tagliata: restano gli ultimi caratteri]\n",
} as const;

/** Variabili del runner che non arrivano ai comandi: codice monouso, token e segreti. */
const HIDDEN_ENV = /CODICE|TOKEN|SECRET|PASSWORD|KEY$/i;

export function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !HIDDEN_ENV.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

/** Taglia a `max` caratteri tenendo la coda (gli errori stanno di solito in fondo). */
export function clip(text: string, max: number = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const note = SHELL_MESSAGES.truncated;
  return note + text.slice(text.length - (max - note.length));
}

/** Cartella di lavoro dentro la radice (risolta con realpath: niente `..` né collegamenti in uscita). */
async function resolveCwd(root: string, cwd: string | undefined): Promise<string | null> {
  try {
    const rootReal = await realpath(root);
    if (cwd === undefined || cwd === "") return rootReal;
    if (path.isAbsolute(cwd)) return null;
    const real = await realpath(path.resolve(rootReal, cwd));
    return real === rootReal || real.startsWith(rootReal + path.sep) ? real : null;
  } catch {
    return null;
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // gruppo già terminato
  }
}

const background = new Map<string, ChildProcess>();
let backgroundSeq = 0;

/** Termina i processi in background (fine del collaudo o del test). */
export function stopBackground(): void {
  for (const child of background.values()) {
    killGroup(child, "SIGTERM");
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    timer.unref();
  }
  background.clear();
}

function startProcess(command: string, cwd: string, env: Record<string, string>): ChildProcess {
  return spawn("bash", ["-lc", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

export async function runShell(cmd: ShellCommand, root: string, opts: ShellOptions = {}): Promise<ShellResult> {
  if (typeof cmd.command !== "string" || cmd.command.trim() === "") return { ok: false, output: SHELL_MESSAGES.invalid };
  const cwd = await resolveCwd(root, cmd.cwd);
  if (!cwd) return { ok: false, output: SHELL_MESSAGES.cwdOutside };
  const env = safeEnv(opts.env);
  return cmd.background ? runBackground(cmd.command, cwd, env, opts.backgroundWaitMs ?? BACKGROUND_WAIT_MS) : runForeground(cmd, cwd, env);
}

function runForeground(cmd: ShellCommand, cwd: string, env: Record<string, string>): Promise<ShellResult> {
  const timeoutSec = Math.min(Math.max(Math.trunc(cmd.timeoutSec ?? DEFAULT_TIMEOUT_SEC), 1), MAX_TIMEOUT_SEC);
  return new Promise((resolve) => {
    let out = "";
    const append = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > KEEP_CHARS * 2) out = out.slice(out.length - KEEP_CHARS);
    };
    let child: ChildProcess;
    try {
      child = startProcess(cmd.command, cwd, env);
    } catch {
      resolve({ ok: false, output: SHELL_MESSAGES.spawnFailed });
      return;
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    }, timeoutSec * 1000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, output: SHELL_MESSAGES.spawnFailed });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        resolve({ ok: false, output: clip(`${out}${out && !out.endsWith("\n") ? "\n" : ""}${SHELL_MESSAGES.timeout(timeoutSec)}`) });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, output: clip(out) });
        return;
      }
      const sep = out && !out.endsWith("\n") ? "\n" : "";
      resolve({ ok: false, output: clip(`${out}${sep}${SHELL_MESSAGES.exitCode(code, signal)}`) });
    });
  });
}

/** Processo che resta acceso: dopo l'attesa si rispondono id e prime righe; l'uscita successiva si scarta. */
function runBackground(command: string, cwd: string, env: Record<string, string>, waitMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    let head = "";
    const collect = (chunk: Buffer) => {
      if (head.length < BACKGROUND_HEAD_CHARS) head += chunk.toString("utf8");
    };
    let child: ChildProcess;
    try {
      child = startProcess(command, cwd, env);
    } catch {
      resolve({ ok: false, output: SHELL_MESSAGES.spawnFailed });
      return;
    }
    const id = `bg-${++backgroundSeq}`;
    background.set(id, child);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let settled = false;
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.on("error", () => {
      background.delete(id);
      finish({ ok: false, output: SHELL_MESSAGES.spawnFailed });
    });
    child.on("exit", (code, signal) => {
      background.delete(id);
      const body = head.slice(0, BACKGROUND_HEAD_CHARS);
      const sep = body && !body.endsWith("\n") ? "\n" : "";
      finish({ ok: code === 0, output: clip(`id: ${id} (già terminato)\n${body}${sep}${SHELL_MESSAGES.exitCode(code, signal)}`) });
    });
    setTimeout(() => {
      finish({ ok: true, output: clip(`id: ${id} (acceso in background)\n${head.slice(0, BACKGROUND_HEAD_CHARS)}`) });
    }, waitMs);
  });
}
