import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeReportBody, nodeReportBodyDetailMax, nodeReportBodyOutcomeMax } from "@workspace/api-zod";
import { z } from "zod";
import { LEASE_LOST, LeaseLostError, type CaselloClient, type TaskPackage, type TaskReport } from "./client";
import type { Config } from "./config";
import type { Logger } from "./log";
import { ATTACHMENTS_DIR, OUTCOME_FILE, renderTaskFile, TASK_FILE } from "./task-file";
import { isInside, resolveWorkspace, WORKSPACE_INVALID, WorkspaceError } from "./workspace";

export const PROMPT = "Leggi casello-compito.md in questa cartella ed eseguilo.";
export const TIMEOUT_OUTCOME = "tempo massimo superato";
export const ATTACHMENT_INVALID = "allegato non valido";

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
  /** Chiamata a ogni lease rinnovata, con la nuova scadenza. */
  onLeaseRenewed?: (expiresAt: Date) => void;
}

/** Esito scritto dall'operaio in `casello-esito.json` (stato dal contratto, testi troncati dopo). */
const OutcomeFile = z.object({
  status: NodeReportBody.shape.status,
  outcome: z.string().trim().min(1),
  detail: z.string().optional(),
});

/** Risultato JSON di `claude -p --output-format json` (solo i campi usati). */
const CliResult = z.object({
  is_error: z.boolean().optional(),
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
type CliResult = z.infer<typeof CliResult>;

const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const TOKENS_MAX = 2_000_000_000;
const COST_MAX = 100_000;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function permissionArgs(mode: string): string[] {
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode];
}

/** Ambiente del processo figlio senza le variabili `CASELLO_*` (il token del nodo non passa all'operaio). */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CASELLO_")) env[k] = v;
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
  for (const a of pkg.attachments) {
    const name = path.basename(a.name);
    if (!a.name || name !== a.name || name === "." || name === "..") throw new AttachmentError();
    let data: Buffer;
    try {
      data = await client.downloadAttachment(pkg.taskId, a.id, pkg.leaseToken);
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
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

interface ChildResult {
  timedOut: boolean;
  leaseLost: boolean;
  exitCode: number | null;
  spawnFailed: boolean;
  stdout: string;
}

async function runClaude(
  pkg: TaskPackage,
  workspace: string,
  sessionId: string,
  ctx: RunContext,
): Promise<ChildResult> {
  const spawn = ctx.spawn ?? nodeSpawn;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--session-id",
    sessionId,
    ...permissionArgs(ctx.config.permissionMode),
    PROMPT,
  ];
  const killGraceMs = ctx.killGraceMs ?? 10_000;

  return new Promise<ChildResult>((resolve) => {
    const result: ChildResult = { timedOut: false, leaseLost: false, exitCode: null, spawnFailed: false, stdout: "" };
    const chunks: Buffer[] = [];
    let size = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(ctx.config.claudeBin, args, { cwd: workspace, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ...result, spawnFailed: true });
      return;
    }

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
    };

    const timeout = setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, ctx.config.taskTimeoutMinutes * 60_000);

    const ping = setInterval(
      () => {
        ctx.client.ping(pkg.taskId, pkg.leaseToken).then(
          (expiresAt) => ctx.onLeaseRenewed?.(expiresAt),
          (err: unknown) => {
            if (err instanceof LeaseLostError) {
              ctx.logger?.warn(`compito ${pkg.taskId}: lease persa, interrompo Claude Code`);
              result.leaseLost = true;
              terminate();
            } else {
              ctx.logger?.warn(`compito ${pkg.taskId}: ping non riuscito (${(err as Error).message})`);
            }
          },
        );
      },
      ctx.pingIntervalMs ?? 5 * 60_000,
    );

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(ping);
      if (killTimer) clearTimeout(killTimer);
      result.stdout = Buffer.concat(chunks).toString("utf8");
      resolve(result);
    };

    child.stdout?.on("data", (c: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += c.length;
      chunks.push(c);
    });
    child.stderr?.resume();
    child.on("error", () => {
      result.spawnFailed = true;
      finish();
    });
    child.on("close", (code) => {
      result.exitCode = code;
      finish();
    });
  });
}

function parseCli(stdout: string): CliResult | null {
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

function usageFields(cli: CliResult | null): Pick<TaskReport, "costUsd" | "promptTokens" | "completionTokens"> {
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
 * Esegue un compito del nodo con Claude Code e restituisce il report da inviare a Casello (validato con lo schema del
 * contratto). Non lancia eccezioni per gli esiti attesi: spazio di lavoro non valido → `blocked`, allegato non valido,
 * tempo massimo o errore della CLI → `failed`. I file di servizio vengono rimossi alla fine.
 */
export async function runTask(pkg: TaskPackage, ctx: RunContext): Promise<TaskReport> {
  const sessionId = randomUUID();
  const base = { leaseToken: pkg.leaseToken, sessionId };
  const done = (r: Omit<TaskReport, "leaseToken" | "sessionId">): TaskReport => NodeReportBody.parse({ ...base, ...r });

  let workspace: string;
  try {
    workspace = await resolveWorkspace(ctx.config.workspaceRoot, pkg.workspace);
  } catch (err) {
    if (err instanceof WorkspaceError) {
      ctx.logger?.warn(`compito ${pkg.taskId}: ${WORKSPACE_INVALID}`);
      return done({ status: "blocked", outcome: WORKSPACE_INVALID });
    }
    throw err;
  }

  const taskFile = path.join(workspace, TASK_FILE);
  const outcomeFile = path.join(workspace, OUTCOME_FILE);
  try {
    try {
      await fetchAttachments(pkg, workspace, ctx.client);
    } catch (err) {
      if (err instanceof AttachmentError || err instanceof LeaseLostError) {
        ctx.logger?.warn(`compito ${pkg.taskId}: ${err.message}`);
        return done({ status: "failed", outcome: err instanceof LeaseLostError ? err.message : ATTACHMENT_INVALID });
      }
      throw err;
    }

    await rm(outcomeFile, { force: true });
    await rm(taskFile, { force: true });
    await writeFile(taskFile, renderTaskFile(pkg), { mode: 0o600, flag: "wx" });

    ctx.logger?.info(`compito ${pkg.taskId}: avvio Claude Code (sessione ${sessionId})`);
    const child = await runClaude(pkg, workspace, sessionId, ctx);
    const cli = parseCli(child.stdout);
    const usage = usageFields(cli);
    ctx.logger?.info(
      `compito ${pkg.taskId}: Claude Code terminato (codice ${child.exitCode ?? "nessuno"}${child.timedOut ? ", tempo massimo" : ""})`,
    );

    if (child.timedOut) return done({ status: "failed", outcome: TIMEOUT_OUTCOME, ...usage });
    if (child.leaseLost) return done({ status: "failed", outcome: LEASE_LOST, ...usage });
    if (child.spawnFailed) return done({ status: "failed", outcome: "Claude Code non avviabile" });

    const fromFile = await readOutcomeFile(workspace);
    if (fromFile) {
      return done({
        status: fromFile.status,
        outcome: truncate(fromFile.outcome, nodeReportBodyOutcomeMax),
        ...(fromFile.detail ? { detail: truncate(fromFile.detail, nodeReportBodyDetailMax) } : {}),
        ...usage,
      });
    }
    if (!cli) {
      return done({
        status: "failed",
        outcome: `Claude Code terminato senza esito (codice ${child.exitCode ?? "nessuno"})`,
      });
    }
    const text = (cli.result ?? "").trim();
    if (cli.is_error) {
      return done({
        status: "failed",
        outcome: truncate(text || "Claude Code ha restituito un errore", nodeReportBodyOutcomeMax),
        ...(text ? { detail: truncate(text, nodeReportBodyDetailMax) } : {}),
        ...usage,
      });
    }
    return done({
      status: "done",
      outcome: truncate(text || "compito eseguito senza esito scritto", nodeReportBodyOutcomeMax),
      ...(text ? { detail: truncate(text, nodeReportBodyDetailMax) } : {}),
      ...usage,
    });
  } finally {
    await rm(taskFile, { force: true });
    await rm(outcomeFile, { force: true });
  }
}
