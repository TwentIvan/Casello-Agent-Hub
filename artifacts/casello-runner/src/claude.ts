import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Esecuzione di un compito con Claude Code in modalità non interattiva (`claude -p`), collegato soltanto al server
// MCP di Casello con il token del lavoro. Flag verificati su Claude Code 2.1.311 (`claude --help`):
// - `-p` + `--output-format json`: un solo esito JSON su stdout (`session_id`, `is_error`, `usage`);
// - `--mcp-config <file>` + `--strict-mcp-config`: solo il server "casello" del file, ignorati gli altri MCP
//   configurati dall'utente;
// - `--tools ""`: nessuno strumento predefinito (shell, file, web, sotto-agenti): restano solo quelli MCP;
// - `--allowedTools mcp__casello`: tutti gli strumenti del server "casello" senza richiesta di permesso;
// - `--permission-mode dontAsk`: ciò che non è preautorizzato viene negato, mai chiesto (niente attese appese);
// - `--setting-sources user`: solo le impostazioni dell'utente (dove Claude Code tiene anche l'eventuale
//   `apiKeyHelper`), mai quelle di progetto o locali di una cartella; l'accesso (OAuth/portachiavi) non è nelle
//   impostazioni e resta valido;
// - `--resume <id>`: ripresa della sessione sospesa (conferme, correzioni dell'architetto). Claude Code lega la
//   sessione alla cartella di lavoro: tutti i compiti di un lavoro usano la stessa cartella (`workDir`).
// Il prompt arriva dallo stdin e non dagli argomenti: non è visibile con `ps` e le opzioni a valori multipli
// (`--mcp-config`, `--tools`, `--allowedTools`) non possono inglobarlo.

export interface ClaudeItem {
  prompt: string;
  resumeSessionId: string | null;
  /** Indirizzo del server MCP di Casello (dalla consegna). */
  mcpUrl: string;
  /** Token del lavoro di QUESTA consegna (Casello lo rigenera a ogni consegna). */
  jobToken: string;
}

export interface ItemResult {
  sessionId: string | null;
  exit: "done" | "error";
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface RunClaudeOptions {
  /** Programma `claude` (percorso o nome nel PATH). */
  bin: string;
  /** Annullamento (lavoro scaduto, arresto del runner): SIGTERM, poi SIGKILL dopo `killGraceMs`. */
  signal: AbortSignal;
  killGraceMs?: number;
  /** Cartella di lavoro di Claude: la stessa per tutti i compiti di un lavoro (vuota, 0700). */
  workDir: string;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
// Esito JSON atteso entro questa dimensione: oltre si scarta (resta l'esito d'errore)
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MCP_SERVER_NAME = "casello";

/** Host di sviluppo ammessi in http; altrove solo https (il token viaggia in chiaro altrimenti). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Indirizzo accettabile per Casello o per il suo server MCP: https, oppure http solo verso localhost. */
export function isSecureUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
}

// Processi `claude` vivi e cartelle temporanee dei compiti in corso: al secondo segnale di arresto il runner esce
// subito e li chiude in modo sincrono (`killAllSync`)
const liveChildren = new Set<ChildProcess>();
const liveTempDirs = new Set<string>();

/** Uscita immediata: SIGKILL ai processi `claude` vivi e cancellazione sincrona delle cartelle temporanee. */
export function killAllSync(): void {
  for (const child of liveChildren) child.kill("SIGKILL");
  liveChildren.clear();
  for (const dir of liveTempDirs) rmSync(dir, { recursive: true, force: true });
  liveTempDirs.clear();
}

/** Argomenti di `claude` per un compito (vedi in testa al file). */
export function claudeArgs(mcpConfigPath: string, resumeSessionId: string | null): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "user",
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return args;
}

/** Sessione, esito e token dall'output JSON di `claude -p --output-format json` (null se illeggibile). */
function parseOutput(stdout: string): { sessionId: string | null; isError: boolean; usage: ItemResult["usage"] } | null {
  let out: unknown;
  try {
    out = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!out || typeof out !== "object") return null;
  const o = out as Record<string, unknown>;
  const sessionId = typeof o["session_id"] === "string" && o["session_id"] ? o["session_id"] : null;
  const u = o["usage"] && typeof o["usage"] === "object" ? (o["usage"] as Record<string, unknown>) : null;
  const n = (k: string) => (u && typeof u[k] === "number" && Number.isFinite(u[k]) && (u[k] as number) >= 0 ? Math.floor(u[k] as number) : 0);
  // Token in ingresso: anche quelli scritti e letti dalla cache del prompt (a titolo informativo)
  const usage = u
    ? { inputTokens: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"), outputTokens: n("output_tokens") }
    : null;
  return { sessionId, isError: o["is_error"] === true, usage };
}

/**
 * Esegue un compito con Claude Code nella cartella del lavoro (`workDir`), con `mcp.json` (0600) e il token del
 * lavoro in una cartella temporanea a parte, cancellata sempre alla fine; prompt dallo stdin. Mai un'eccezione:
 * ogni guasto diventa `exit: "error"`.
 */
export async function runClaude(item: ClaudeItem, opts: RunClaudeOptions): Promise<ItemResult> {
  const failed: ItemResult = { sessionId: null, exit: "error", usage: null };
  if (!isSecureUrl(item.mcpUrl) || opts.signal.aborted) return failed;
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "casello-runner-"));
  } catch {
    return failed;
  }
  liveTempDirs.add(dir);
  try {
    const configPath = join(dir, "mcp.json");
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "http", url: item.mcpUrl, headers: { Authorization: `Bearer ${item.jobToken}` } },
      },
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });

    // Claude Code non vede il token di macchina
    const env = { ...process.env };
    delete env["CASELLO_RUNNER_TOKEN"];
    const { code, stdout } = await spawnClaude(opts, claudeArgs(configPath, item.resumeSessionId), opts.workDir, env, item.prompt);
    const parsed = parseOutput(stdout);
    if (!parsed) return failed;
    const ok = code === 0 && !parsed.isError && !opts.signal.aborted;
    return { sessionId: parsed.sessionId, exit: ok ? "done" : "error", usage: parsed.usage };
  } catch {
    return failed;
  } finally {
    await rm(dir, { recursive: true, force: true });
    liveTempDirs.delete(dir);
  }
}

/** Avvia `claude` e ne attende l'uscita; codice null se non è partito o è stato terminato. */
function spawnClaude(
  opts: RunClaudeOptions,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(opts.bin, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    liveChildren.add(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      clearTimeout(killTimer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout: size <= MAX_STDOUT_BYTES ? Buffer.concat(chunks).toString("utf8") : "" });
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDOUT_BYTES) chunks.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    // Claude che esce senza leggere tutto il prompt: EPIPE ignorato, conta l'uscita
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
