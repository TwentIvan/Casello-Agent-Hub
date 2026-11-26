// Entrata del programma di collaudo: `node casello-collaudo.mjs --url <botcave> --collaudo <id>`.
// Il codice monouso arriva solo da COLLAUDO_CODICE (mai dagli argomenti) e si toglie subito dall'ambiente.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { playwrightDriver } from "./browser";
import { CollaudoClient } from "./client";
import { cloneAt } from "./clone";
import { runCollaudo } from "./loop";
import { openTunnel } from "./tunnel";

/** Iniettata dalla build (scripts/build.mjs, da package.json); assente nei test. */
declare const __COLLAUDO_VERSION__: string | undefined;
export const COLLAUDO_VERSION: string = typeof __COLLAUDO_VERSION__ === "string" ? __COLLAUDO_VERSION__ : "0.1.0";

const USAGE = "uso: casello-collaudo --url <indirizzo di Botcave> --collaudo <id> (codice in COLLAUDO_CODICE)";

function log(msg: string): void {
  process.stdout.write(`[casello-collaudo] ${msg}\n`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** https, oppure http solo verso localhost (sviluppo). */
export function checkBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${COLLAUDO_VERSION}\n`);
    return 0;
  }
  const code = process.env.COLLAUDO_CODICE ?? "";
  delete process.env.COLLAUDO_CODICE;
  const baseUrl = checkBaseUrl(arg("--url"));
  const testId = Number(arg("--collaudo"));
  if (!baseUrl || !Number.isInteger(testId) || testId <= 0 || code === "") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  log(`versione ${COLLAUDO_VERSION}, collaudo ${testId}`);
  const workDir = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), "collaudo-"));
  const outcome = await runCollaudo(testId, code, {
    client: new CollaudoClient(baseUrl),
    workDir,
    clone: (repo, sha, token, dir) => cloneAt(repo, sha, token, dir),
    browser: () => playwrightDriver(path.join(workDir, "video")),
    openTunnel,
    log,
  });
  log(`fine: ${outcome}`);
  return outcome === "failed" ? 1 : 0;
}

main().then(
  (exitCode) => process.exit(exitCode),
  (err: unknown) => {
    log(`errore interno: ${err instanceof Error ? err.name : "sconosciuto"}`);
    process.exit(1);
  },
);
