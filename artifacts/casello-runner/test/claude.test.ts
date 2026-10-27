import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeArgs, runClaude } from "../src/claude";

// Avvio di Claude Code per un compito: argomenti, configurazione MCP temporanea, esito e arresto. Il finto `claude`
// (fake-claude.mjs) registra quello che riceve in un file JSONL.

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const JOB_TOKEN = "csl_j_SEGRETO_DEL_LAVORO_123";

let scratch: string;
let record: string;
const savedEnv = { ...process.env };

function records(): any[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const item = (over: Partial<Parameters<typeof runClaude>[0]> = {}) => ({
  prompt: "Fai il lavoro",
  resumeSessionId: null,
  mcpUrl: "https://casello.example/api/mcp",
  jobToken: JOB_TOKEN,
  ...over,
});

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "runner-test-"));
  record = join(scratch, "record.jsonl");
  process.env["FAKE_CLAUDE_RECORD"] = record;
  process.env["FAKE_CLAUDE_MODE"] = "record";
  process.env["CASELLO_RUNNER_TOKEN"] = "csl_m_TOKEN_DI_MACCHINA";
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(scratch, { recursive: true, force: true });
});

describe("claudeArgs", () => {
  it("modalità non interattiva, solo il server MCP di Casello, nessuno strumento predefinito, nessuna richiesta", () => {
    expect(claudeArgs("/tmp/x/mcp.json", null)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--mcp-config",
      "/tmp/x/mcp.json",
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__casello",
      "--permission-mode",
      "dontAsk",
    ]);
    expect(claudeArgs("/tmp/x/mcp.json", "sess-1").slice(-2)).toEqual(["--resume", "sess-1"]);
  });
});

describe("runClaude", () => {
  it("cartella temporanea vuota, mcp.json 0600 con il token del lavoro, prompt dallo stdin; tutto rimosso alla fine", async () => {
    const result = await runClaude(item({ resumeSessionId: "sess-9" }), { bin: FAKE_CLAUDE, signal: new AbortController().signal });

    expect(result).toEqual({ sessionId: "sess-9", exit: "done", usage: { inputTokens: 15, outputTokens: 5 } });
    const [r] = records();
    expect(r.args).toEqual(claudeArgs(r.configPath, "sess-9"));
    // Il prompt non sta negli argomenti (visibili con `ps`): arriva dallo stdin
    expect(r.args.join(" ")).not.toContain("Fai il lavoro");
    expect(r.promptLength).toBe("Fai il lavoro".length);
    // (su macOS la cartella di lavoro vista dal processo è il percorso reale, con /private davanti)
    expect(basename(r.configPath)).toBe("mcp.json");
    expect(r.cwd.endsWith(dirname(r.configPath))).toBe(true);
    expect(r.cwdFiles).toEqual(["mcp.json"]);
    expect(r.configMode).toBe(0o600);
    expect(r.config).toEqual({
      mcpServers: { casello: { type: "http", url: "https://casello.example/api/mcp", headers: { Authorization: `Bearer ${JOB_TOKEN}` } } },
    });
    // Il token di macchina non arriva a Claude Code
    expect(r.machineTokenInEnv).toBe(false);
    expect(existsSync(r.configPath)).toBe(false);
    expect(existsSync(r.cwd)).toBe(false);
  });

  it("esito d'errore o codice di uscita diverso da 0: exit error, con la sessione se Claude l'ha riportata", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "fail";
    const result = await runClaude(item({ resumeSessionId: "sess-2" }), { bin: FAKE_CLAUDE, signal: new AbortController().signal });
    expect(result).toEqual({ sessionId: "sess-2", exit: "error", usage: { inputTokens: 15, outputTokens: 5 } });
    expect(existsSync(records()[0].cwd)).toBe(false);
  });

  it("programma inesistente: exit error, cartella rimossa", async () => {
    const result = await runClaude(item(), { bin: join(scratch, "non-esiste"), signal: new AbortController().signal });
    expect(result).toEqual({ sessionId: null, exit: "error", usage: null });
    expect(records()).toEqual([]);
  });

  it("indirizzo MCP non https (fuori da localhost): non avvia Claude", async () => {
    const result = await runClaude(item({ mcpUrl: "http://casello.example/api/mcp" }), { bin: FAKE_CLAUDE, signal: new AbortController().signal });
    expect(result.exit).toBe("error");
    expect(records()).toEqual([]);
  });

  it("annullamento: SIGTERM, poi SIGKILL dopo l'attesa se Claude non esce; exit error", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    const ac = new AbortController();
    const started = Date.now();
    const pending = runClaude(item(), { bin: FAKE_CLAUDE, signal: ac.signal, killGraceMs: 300 });
    for (let i = 0; i < 200 && records().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const [r] = records();
    ac.abort();
    const result = await pending;
    expect(result.exit).toBe("error");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(() => process.kill(r.pid, 0)).toThrow();
    expect(existsSync(r.cwd)).toBe(false);
  });
});
