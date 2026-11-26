// Ciclo del runner di collaudo: claim, copia del codice, comandi del collaudatore fino a «collaudo consegnato» (410),
// video, link dal vivo per 30 minuti e report. In modalità `relight` niente agente: ricetta, tunnel e report.
// Un 401 su qualunque chiamata (collaudo chiuso o annullato) ferma tutto senza report. Nei log solo fasi, id ed esiti.

import path from "node:path";
import { runBrowser, type BrowserDriver } from "./browser";
import { CollaudoClosedError, CollaudoHttpError, type ClaimPackage, type CollaudoClient, type RunnerCommand } from "./client";
import { RUNNER_DATABASE_URL, recipeEnv, runRecipe as defaultRunRecipe, type RecipeRunResult, type TestRecipe } from "./recipe-run";
import { runShell, stopBackground } from "./shell";
import type { Tunnel } from "./tunnel";

export const TUNNEL_MS = 30 * 60_000;
export const PING_MS = 30_000;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
const DEFAULT_APP_PORT = 3000;
const MAX_NEXT_FAILURES = 6;
const MAX_RESULT_ATTEMPTS = 3;

export type LoopDeps = {
  client: CollaudoClient;
  workDir: string;
  clone: (repo: string, sha: string, repoToken: string, dir: string) => Promise<void>;
  browser: () => Promise<BrowserDriver>;
  openTunnel: (port: number) => Promise<Tunnel>;
  runRecipe?: (recipe: TestRecipe, root: string) => Promise<RecipeRunResult>;
  tunnelMs?: number;
  pingMs?: number;
  log: (msg: string) => void;
};

export type LoopOutcome = "done" | "failed" | "closed";

const isClosed = (err: unknown) => err instanceof CollaudoClosedError;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Porta locale dell'URL (localhost o 127.0.0.1), se c'è. */
function localPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export async function runCollaudo(testId: number, code: string, deps: LoopDeps): Promise<LoopOutcome> {
  const { client, log } = deps;
  const stop = new AbortController();
  let closed = false;
  const markClosed = () => {
    if (!closed) log("collaudo chiuso o annullato da Botcave: mi fermo");
    closed = true;
    stop.abort();
  };

  let pkg: ClaimPackage;
  try {
    pkg = await client.claim(testId, code);
  } catch (err) {
    if (isClosed(err)) {
      log("codice rifiutato da Botcave");
      return "closed";
    }
    log(`claim non riuscito: ${(err as Error).message}`);
    return "failed";
  }
  log(`collaudo ${testId} preso in carico (modalità ${pkg.mode})`);

  const pinger = setInterval(() => {
    client.ping().catch((err) => {
      if (isClosed(err)) markClosed();
      else log("ping non riuscito");
    });
  }, deps.pingMs ?? PING_MS);

  let driver: BrowserDriver | null = null;
  let tunnel: Tunnel | null = null;
  // Porta dell'App: quella della ricetta o l'ultima localhost aperta nel browser
  let appPort: number | null = pkg.recipe?.services[0]?.port ?? null;
  const root = path.join(deps.workDir, "app");

  const finish = async (status: "done" | "failed"): Promise<LoopOutcome> => {
    if (closed) return "closed";
    try {
      await client.report(status);
      log(`report mandato: ${status}`);
    } catch (err) {
      if (isClosed(err)) return "closed";
      log(`report non mandato: ${(err as Error).message}`);
    }
    return status;
  };

  try {
    try {
      await deps.clone(pkg.repo, pkg.sha, pkg.repoToken, root);
      log(`codice copiato (${pkg.sha.slice(0, 7)})`);
    } catch {
      log("copia del codice non riuscita");
      return await finish("failed");
    }

    if (pkg.mode === "relight") {
      if (!pkg.recipe) {
        log("nessuna ricetta da eseguire");
        return await finish("failed");
      }
      const r = await (deps.runRecipe ?? ((rec, dir) => defaultRunRecipe(rec, dir)))(pkg.recipe, root);
      if (closed) return "closed";
      if (!r.ok) {
        log("ricetta non riuscita");
        return await finish("failed");
      }
      appPort = r.port;
    } else {
      // RUNNER_DATABASE_URL sempre: il collaudatore conosce il Postgres del runner anche senza ricetta
      const shellEnv = pkg.recipe ? recipeEnv(pkg.recipe) : { RUNNER_DATABASE_URL };
      const execute = async (cmd: RunnerCommand): Promise<{ ok: boolean; output: string }> => {
        if (cmd.kind === "shell") {
          const a = cmd.args;
          if (typeof a.command !== "string") return { ok: false, output: "argomenti non validi: serve command (testo)" };
          return runShell(
            {
              command: a.command,
              cwd: typeof a.cwd === "string" ? a.cwd : undefined,
              timeoutSec: typeof a.timeoutSec === "number" ? a.timeoutSec : undefined,
              background: a.background === true,
            },
            root,
            { env: shellEnv },
          );
        }
        if (cmd.kind === "browser") {
          if (cmd.args.action === "open" && typeof cmd.args.url === "string") appPort = localPort(cmd.args.url) ?? appPort;
          return runBrowser(cmd.args, {
            driver: async () => (driver ??= await deps.browser()),
            baseUrl: () => `http://localhost:${appPort ?? DEFAULT_APP_PORT}`,
            uploadScreenshot: async (png) => {
              const n = Date.now();
              return (await client.uploadFile("screenshot", `screenshot-${n}.png`, png)).id;
            },
          });
        }
        return { ok: false, output: "comando sconosciuto" };
      };

      let failures = 0;
      let liveLink = true;
      for (;;) {
        if (closed) return "closed";
        let next;
        try {
          next = await client.next(stop.signal);
          failures = 0;
        } catch (err) {
          if (isClosed(err) || closed) {
            markClosed();
            return "closed";
          }
          if (++failures >= MAX_NEXT_FAILURES) {
            log("Botcave non risponde: chiudo il collaudo");
            return await finish("failed");
          }
          await sleep(Math.min(2_000 * 2 ** (failures - 1), 30_000), stop.signal);
          continue;
        }
        if (next.type === "delivered") {
          liveLink = next.liveLink;
          break;
        }
        if (next.type === "none") continue;
        const cmd = next.command;
        const result = await execute(cmd);
        log(`comando ${cmd.id} (${cmd.kind}): ${result.ok ? "riuscito" : "non riuscito"}`);
        for (let attempt = 1; ; attempt++) {
          try {
            if (!(await client.result(cmd.id, result))) log(`comando ${cmd.id} non più atteso da Botcave`);
            break;
          } catch (err) {
            if (isClosed(err)) {
              markClosed();
              return "closed";
            }
            if (attempt >= MAX_RESULT_ATTEMPTS || !(err instanceof CollaudoHttpError)) {
              log(`risultato del comando ${cmd.id} non mandato`);
              break;
            }
            await sleep(2_000 * attempt, stop.signal);
          }
        }
      }
      log("collaudo consegnato");

      if (driver) {
        const { video } = await (driver as BrowserDriver).close();
        driver = null;
        if (video && video.length <= MAX_VIDEO_BYTES) {
          try {
            await client.uploadFile("video", "video.webm", video);
            log("video caricato");
          } catch (err) {
            if (isClosed(err)) {
              markClosed();
              return "closed";
            }
            log("video non caricato");
          }
        }
      }
      if (!liveLink) {
        log("nessun esito da provare dal vivo: niente link");
        return await finish("done");
      }
    }

    if (appPort === null) {
      log("porta dell'App non nota: niente link dal vivo");
      return await finish("done");
    }
    try {
      tunnel = await deps.openTunnel(appPort);
    } catch {
      log("tunnel non aperto: niente link dal vivo");
      return await finish("done");
    }
    const tunnelMs = deps.tunnelMs ?? TUNNEL_MS;
    try {
      await client.tunnel(tunnel.url, new Date(Date.now() + tunnelMs).toISOString());
      log("link dal vivo aperto");
    } catch (err) {
      if (isClosed(err)) {
        markClosed();
        return "closed";
      }
      log("link dal vivo non registrato");
      return await finish("done");
    }
    await sleep(tunnelMs, stop.signal);
    if (closed) return "closed";
    tunnel.close();
    tunnel = null;
    log("link dal vivo chiuso");
    return await finish("done");
  } catch (err) {
    if (isClosed(err) || closed) {
      markClosed();
      return "closed";
    }
    log(`errore interno del runner: ${err instanceof Error ? err.name : "sconosciuto"}`);
    return await finish("failed");
  } finally {
    clearInterval(pinger);
    tunnel?.close();
    if (driver) await (driver as BrowserDriver).close().catch(() => undefined);
    stopBackground();
  }
}
