import { realExec, realRun, type ExecLongFn, type RunFn } from "./claude-check";

const CHECK_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 60_000;
const STATUS_TTL_MS = 600_000;
const VERSION_MAX = 50;

/** Stato di Git mandato nell'heartbeat. */
export type GitStatus = { found: boolean; version: string | null };

/** Verifica di Git (`git --version`): presenza e versione. Non lancia mai. */
export async function checkGit(d: { run?: RunFn }): Promise<GitStatus> {
  const out = await (d.run ?? realRun)("git", ["--version"], CHECK_TIMEOUT_MS).catch(() => null);
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
