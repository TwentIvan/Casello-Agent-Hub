import { existsSync } from "node:fs";
import { realExec, realRun, type ExecLongFn, type RunFn } from "./claude-check";

const CHECK_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;
const STATUS_TTL_MS = 600_000;
const VERSION_MAX = 50;

/** Stato di Git mandato nell'heartbeat. */
export type GitStatus = { found: boolean; version: string | null };

/** Git installati a parte (Homebrew su Apple silicon e su Intel): si usano così come sono. */
const STANDALONE_GITS = ["/opt/homebrew/bin/git", "/usr/local/bin/git"];
const SYSTEM_GIT = "/usr/bin/git";

/**
 * Percorso del Git da usare, o null. `/usr/bin/git` vale solo con gli strumenti da riga di comando di Apple installati
 * (`xcode-select -p` riesce): senza, è un rimando che a ogni avvio apre il dialogo di installazione di macOS. Non lancia mai.
 */
export async function locateGit(d: { exists?: (p: string) => boolean; run?: RunFn } = {}): Promise<string | null> {
  const exists = d.exists ?? existsSync;
  for (const p of STANDALONE_GITS) if (exists(p)) return p;
  if (!exists(SYSTEM_GIT)) return null;
  const dev = await (d.run ?? realRun)("/usr/bin/xcode-select", ["-p"], CHECK_TIMEOUT_MS).catch(() => null);
  return dev === null ? null : SYSTEM_GIT;
}

/** Verifica di Git (`<git> --version` del Git trovato da `locateGit`): presenza e versione. Non lancia mai. */
export async function checkGit(d: { run?: RunFn; locate?: () => Promise<string | null> }): Promise<GitStatus> {
  const bin = await (d.locate ?? (() => locateGit({ run: d.run })))().catch(() => null);
  if (bin === null) return { found: false, version: null };
  const out = await (d.run ?? realRun)(bin, ["--version"], CHECK_TIMEOUT_MS).catch(() => null);
  if (out === null) return { found: false, version: null };
  const m = /git version (\S+)/.exec(out);
  return { found: true, version: m ? m[1].slice(0, VERSION_MAX) : null };
}

/** Riusa l'ultimo risultato per 10 minuti, come Claude Code. */
export function createCachedGitStatus(
  check: () => Promise<GitStatus>,
  now: () => number = Date.now,
  ttlMs = STATUS_TTL_MS,
): () => Promise<GitStatus> {
  let last: { at: number; status: GitStatus } | null = null;
  return async () => {
    if (!last || now() - last.at >= ttlMs) last = { at: now(), status: await check() };
    return last.status;
  };
}

/** Installazione degli Xcode Command Line Tools (con Git): apre il dialogo di macOS, il nodo se ne accorge dal controllo periodico. */
export async function installGit(d: { exec?: ExecLongFn; notify: (text: string) => Promise<void> }): Promise<void> {
  await (d.exec ?? realExec)("/usr/bin/xcode-select", ["--install"], INSTALL_TIMEOUT_MS).catch(() => {});
  await d.notify("Segui il dialogo di macOS; Botcave Nodo se ne accorge da solo").catch(() => {});
}
