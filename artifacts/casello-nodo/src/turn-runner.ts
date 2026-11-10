import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isLeaseLoss,
  leaseLossReason,
  type CaselloClient,
  type TurnPackage,
  type TurnReport,
} from "./client";
import type { Config } from "./config";
import type { Logger } from "./log";
import { childEnv, parseCli, spawnGroup, usageFields, type CliResult, type SpawnFn } from "./runner";

/** Codici d'errore che il nodo manda a Casello (il resto — lease_lost, node_disabled, restart — lo scrive il server). */
export type NodeTurnErrorCode =
  | "model_unavailable"
  | "timeout"
  | "usage_limit"
  | "not_logged_in"
  | "claude_failed"
  | "stopped";

/** Il server tronca a 20 000 caratteri; il nodo lo fa prima per non superare il limite del corpo JSON. */
export const TURN_CONTENT_MAX = 20_000;
const PING_MS = 30_000;

export interface TurnContext {
  config: Config;
  client: CaselloClient;
  logger: Logger;
  /** Stop del nodo: interrompe il turno (report `stopped`). */
  signal: AbortSignal;
  /** Cartella che contiene le cartelle temporanee dei turni (`~/.casello-nodo/turns`). */
  turnsDir: string;
  spawn?: SpawnFn;
  /** Intervallo dei ping della lease (default 30 s). */
  pingIntervalMs?: number;
  /** Attesa tra SIGTERM e SIGKILL (default 10 s). */
  killGraceMs?: number;
  /** Chiamata a ogni lease rinnovata. */
  onLeaseRenewed?: (expiresAt: Date) => void;
}

/**
 * Argomenti di `claude` per un turno: nessuno strumento proprio, solo il server MCP del turno, modalità `dontAsk`
 * fissa (la `permissionMode` della config vale solo per i compiti). Il prompt arriva su stdin, il prompt di sistema da
 * un file (fuori dagli argomenti, visibili con `ps`). `--setting-sources project` con la cartella vuota del turno come
 * cwd: le impostazioni personali di Claude Code dell'utente del Mac (hook, permessi, plugin) non entrano nel turno.
 */
export function turnArgs(pkg: TurnPackage, mcpConfigPath: string, systemPromptPath: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    pkg.model,
    "--system-prompt-file",
    systemPromptPath,
    "--setting-sources",
    "project",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--allowedTools",
    "mcp__botcave__*",
    "--max-turns",
    String(pkg.maxTurns),
    "--permission-mode",
    "dontAsk",
  ];
}

const USAGE_LIMIT = ["usage limit", "rate limit", "limit reached", "hour limit", "weekly limit"];
const NOT_LOGGED_IN = [
  "not logged in",
  "please run /login",
  "/login",
  "invalid api key",
  "oauth token has expired",
  "oauth token revoked",
  "authentication_error",
];

/**
 * Sceglie il codice dal testo dell'errore (solo per classificare: il testo non si inoltra mai).
 * Stop e timeout hanno la precedenza sul testo.
 */
export function classifyTurnError(text: string, timedOut: boolean, aborted: boolean): NodeTurnErrorCode {
  if (aborted) return "stopped";
  if (timedOut) return "timeout";
  const t = text.toLowerCase();
  // Solo frasi precise: usage_limit e not_logged_in fanno scattare il ripiego sul cloud, che non deve partire per
  // errori generici (contesto troppo lungo, avvisi MCP/OAuth) dopo che Claude può aver già chiamato strumenti
  if (USAGE_LIMIT.some((p) => t.includes(p))) return "usage_limit";
  if (NOT_LOGGED_IN.some((p) => t.includes(p))) return "not_logged_in";
  if (
    t.includes("model") &&
    (t.includes("not found") || t.includes("not available") || t.includes("does not exist") || t.includes("invalid model"))
  ) {
    return "model_unavailable";
  }
  return "claude_failed";
}

function mcpConfig(pkg: TurnPackage): string {
  return JSON.stringify({
    mcpServers: {
      botcave: { type: "http", url: pkg.mcpUrl, headers: { Authorization: `Bearer ${pkg.turnToken}` } },
    },
  });
}

function failed(pkg: TurnPackage, errorCode: NodeTurnErrorCode, extra: Partial<TurnReport> = {}): TurnReport {
  return { leaseToken: pkg.leaseToken, status: "failed", errorCode, ...extra };
}

function usage(cli: CliResult | null): Partial<TurnReport> {
  const out: Partial<TurnReport> = { ...usageFields(cli) };
  const cached = cli?.usage?.cache_read_input_tokens;
  if (cached !== undefined && Number.isFinite(cached)) out.cachedTokens = Math.min(Math.max(0, Math.round(cached)), 2_000_000_000);
  if (cli?.session_id) out.sessionId = cli.session_id.slice(0, 200);
  return out;
}

/** Esito del turno dal JSON della CLI e da stderr; `null` = lease persa o nodo che non può riferire. */
function buildReport(
  pkg: TurnPackage,
  child: { timedOut: boolean; aborted: boolean; spawnFailed: boolean; stdout: string; stderr: string; exitCode: number | null },
): TurnReport {
  const cli = parseCli(child.stdout);
  const extra = usage(cli);
  if (child.aborted || child.timedOut) {
    return failed(pkg, classifyTurnError("", child.timedOut && !child.aborted, child.aborted), extra);
  }
  if (child.spawnFailed) return failed(pkg, "claude_failed");
  const text = (cli?.result ?? "").trim();
  const maxTurns = cli?.subtype === "error_max_turns";
  const isError = cli ? (maxTurns ? false : (cli.is_error ?? false) || (cli.subtype?.startsWith("error") ?? false)) : true;
  if (!isError && text) {
    return { leaseToken: pkg.leaseToken, status: "done", content: text.slice(0, TURN_CONTENT_MAX), ...extra };
  }
  if (maxTurns || (cli && !isError)) return failed(pkg, "claude_failed", extra);
  // Con un risultato JSON si classifica solo quello; stderr serve solo se la CLI non ha prodotto un risultato
  return failed(pkg, classifyTurnError(text || child.stderr, false, false), extra);
}

/**
 * Esegue un turno delegato con `claude -p` e ne riferisce l'esito a Casello. Non lancia per gli esiti attesi. Lease
 * persa (409, 401 o 403 su ping o report) → `claude` terminato e nessun report. Mai nei log il token del turno.
 */
export async function runTurn(pkg: TurnPackage, ctx: TurnContext): Promise<void> {
  const { logger } = ctx;
  const startedAt = Date.now();
  logger.info(`turno ${pkg.id}: avvio Claude Code (modello ${pkg.model})`);

  const control = new AbortController();
  let leaseLost = false;
  const onStop = () => control.abort();
  if (ctx.signal.aborted) control.abort();
  else ctx.signal.addEventListener("abort", onStop, { once: true });
  const pinger = setInterval(() => {
    ctx.client.pingTurn(pkg.id, pkg.leaseToken).then(
      (expiresAt) => ctx.onLeaseRenewed?.(expiresAt),
      (err: unknown) => {
        if (isLeaseLoss(err)) {
          if (!leaseLost) logger.warn(`turno ${pkg.id}: lease persa (${leaseLossReason(err)}), interrompo il turno`);
          leaseLost = true;
          control.abort();
        } else {
          logger.warn(`turno ${pkg.id}: ping non riuscito (${(err as Error).message})`);
        }
      },
    );
  }, ctx.pingIntervalMs ?? PING_MS);

  let dir: string | null = null;
  try {
    await mkdir(ctx.turnsDir, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(path.join(ctx.turnsDir, "turno-"));
    const mcpPath = path.join(dir, "mcp.json");
    await writeFile(mcpPath, mcpConfig(pkg), { mode: 0o600 });
    const systemPromptPath = path.join(dir, "system-prompt.md");
    await writeFile(systemPromptPath, pkg.systemPrompt, { mode: 0o600 });

    const child = await spawnGroup({
      command: ctx.config.claudeBin,
      args: turnArgs(pkg, mcpPath, systemPromptPath),
      cwd: dir,
      env: childEnv(),
      stdin: pkg.prompt,
      captureStderr: true,
      timeoutMs: pkg.timeoutMs,
      killGraceMs: ctx.killGraceMs,
      spawn: ctx.spawn,
      logger,
      signal: control.signal,
    });
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (leaseLost) {
      logger.warn(`turno ${pkg.id}: lease persa, nessun report (${seconds} s)`);
      return;
    }
    const report = buildReport(pkg, child);
    logger.info(
      `turno ${pkg.id}: Claude Code terminato in ${seconds} s (${report.status}${report.errorCode ? `, ${report.errorCode}` : ""})`,
    );
    try {
      await ctx.client.reportTurn(pkg.id, report);
      logger.info(`turno ${pkg.id} riferito: ${report.status}`);
    } catch (err) {
      if (isLeaseLoss(err)) logger.warn(`turno ${pkg.id}: report rifiutato, lease persa (${leaseLossReason(err)})`);
      else logger.error(`turno ${pkg.id}: report non consegnato (${(err as Error).message})`);
    }
  } catch (err) {
    // Errore del nodo (es. file system): il turno non resta appeso fino alla scadenza della lease
    logger.error(`turno ${pkg.id}: errore inatteso (${(err as Error).message})`);
    if (!leaseLost) {
      await ctx.client.reportTurn(pkg.id, failed(pkg, "claude_failed")).catch(() => {});
    }
  } finally {
    clearInterval(pinger);
    ctx.signal.removeEventListener("abort", onStop);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
