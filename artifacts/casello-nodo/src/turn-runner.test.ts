import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaselloClient, type TurnPackage } from "./client";
import { createLogger } from "./log";
import { classifyTurnError, runTurn, turnArgs } from "./turn-runner";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, fakeSpawn, tempDir, testConfig, type SpawnCall } from "./test/helpers";

const TURN_TOKEN = "cat_tokendelturno_segretissimo_0123456789";

let casello: FakeCasello;
let base: string;
let turnsDir: string;
let logsDir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: base, cleanup } = await tempDir());
  turnsDir = path.join(base, "turns");
  logsDir = path.join(base, "logs");
  casello = new FakeCasello();
  await casello.start();
  casello.on("POST", "/api/node/turns/:id/report", (_req, res) => json(res, 204));
  casello.on("POST", "/api/node/turns/:id/ping", (_req, res) =>
    json(res, 200, { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }),
  );
});
afterEach(async () => {
  await casello.close();
  await cleanup();
});

function pkg(over: Partial<TurnPackage> = {}): TurnPackage {
  return {
    id: 5,
    leaseToken: "lease-turno",
    model: "sonnet",
    systemPrompt: "Sei Alfred",
    prompt: "[utente] ciao",
    mcpUrl: "http://127.0.0.1:9/mcp/turn",
    turnToken: TURN_TOKEN,
    maxTurns: 8,
    timeoutMs: 60_000,
    ...over,
  };
}

function ctx(mode: string, calls: SpawnCall[] = [], over: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const logger = createLogger({ dir: logsDir, stdout: false, secrets: [FAKE_TOKEN] });
  return {
    config: testConfig({ caselloUrl: casello.url }),
    client: new CaselloClient({ baseUrl: casello.url, token: FAKE_TOKEN, sleep: async () => {} }),
    spawn: fakeSpawn(mode, calls, env),
    logger,
    signal: new AbortController().signal,
    turnsDir,
    pingIntervalMs: 60_000,
    killGraceMs: 200,
    ...over,
  };
}

const reports = () => casello.calls("POST", "/api/node/turns/5/report").map((r) => r.body as Record<string, unknown>);

describe("turnArgs", () => {
  it("argomenti fissi, permission-mode dontAsk, prompt non tra gli argomenti", () => {
    expect(turnArgs(pkg(), "/tmp/x/mcp.json")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "sonnet",
      "--system-prompt",
      "Sei Alfred",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/x/mcp.json",
      "--allowedTools",
      "mcp__botcave__*",
      "--max-turns",
      "8",
      "--permission-mode",
      "dontAsk",
    ]);
  });
});

describe("classifyTurnError", () => {
  it.each([
    ["You have reached your usage limit", "usage_limit"],
    ["Rate limit exceeded", "usage_limit"],
    ["5-hour limit reached", "usage_limit"],
    ["Not logged in · Please run /login", "not_logged_in"],
    ["Invalid API key", "not_logged_in"],
    ["OAuth token has expired", "not_logged_in"],
    ["model foo not found", "model_unavailable"],
    ["The model does not exist", "model_unavailable"],
    ["invalid model", "model_unavailable"],
    ["la solita cosa", "claude_failed"],
    ["", "claude_failed"],
  ])("%s → %s", (text, code) => {
    expect(classifyTurnError(text, false, false)).toBe(code);
  });
  it("timeout e stop hanno la precedenza", () => {
    expect(classifyTurnError("usage limit", true, false)).toBe("timeout");
    expect(classifyTurnError("usage limit", false, true)).toBe("stopped");
  });
});

describe("runTurn", () => {
  it("successo: report done con testo, token, costo, sessione; prompt su stdin; mcp.json 600 poi cancellato", async () => {
    const calls: SpawnCall[] = [];
    let mcp = "";
    let mode = 0;
    const inner = fakeSpawn("turn", calls);
    const c = ctx("turn", calls, {
      spawn: (cmd: string, args: readonly string[], opts: SpawnOptions): ChildProcess => {
        const file = args[args.indexOf("--mcp-config") + 1];
        mcp = readFileSync(file, "utf8");
        mode = statSync(file).mode & 0o777;
        expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        return inner(cmd, args, opts);
      },
    });
    await runTurn(pkg(), c);
    expect(JSON.parse(mcp)).toEqual({
      mcpServers: {
        botcave: { type: "http", url: "http://127.0.0.1:9/mcp/turn", headers: { Authorization: `Bearer ${TURN_TOKEN}` } },
      },
    });
    expect(mode).toBe(0o600);
    expect(calls[0].args).not.toContain("[utente] ciao");
    expect(calls[0].args).toContain("dontAsk");
    expect(reports()).toEqual([
      {
        leaseToken: "lease-turno",
        status: "done",
        content: "ciao ([utente] ciao)",
        promptTokens: 125,
        completionTokens: 40,
        cachedTokens: 20,
        costUsd: 0.01,
        sessionId: "s",
      },
    ]);
    expect(await readdir(turnsDir)).toEqual([]);
    // il token del turno non è mai nel log
    const log = readFileSync(path.join(logsDir, "casello-nodo.log"), "utf8");
    expect(log).toContain("turno 5");
    expect(log).not.toContain(TURN_TOKEN);
    // né nell'ambiente passato a claude
    expect(Object.values(calls[0].options.env ?? {})).not.toContain(TURN_TOKEN);
  });

  it("il testo oltre 20 000 caratteri si tronca", async () => {
    await runTurn(pkg({ prompt: "x".repeat(25_000) }), ctx("turn"));
    const [r] = reports();
    expect((r.content as string).length).toBe(20_000);
  });

  it.each([
    ["You've hit your usage limit", "usage_limit"],
    ["Not logged in · Please run /login", "not_logged_in"],
    ["model foo not found", "model_unavailable"],
    ["qualcosa di strano", "claude_failed"],
  ])("is_error «%s» → failed %s, senza inoltrare il testo", async (text, code) => {
    await runTurn(pkg(), ctx("turn-error", [], {}, { FAKE_ERROR_TEXT: text }));
    expect(reports()).toEqual([expect.objectContaining({ status: "failed", errorCode: code })]);
    expect(JSON.stringify(reports())).not.toContain(text);
    expect(await readdir(turnsDir)).toEqual([]);
  });

  it("errore solo su stderr con uscita ≠ 0 → classificato da stderr", async () => {
    await runTurn(pkg(), ctx("turn-stderr", [], {}, { FAKE_ERROR_TEXT: "Please run /login" }));
    expect(reports()).toEqual([expect.objectContaining({ status: "failed", errorCode: "not_logged_in" })]);
  });

  it("error_max_turns: done se c'è un risultato, altrimenti claude_failed", async () => {
    await runTurn(pkg(), ctx("turn-maxturns", [], {}, { FAKE_RESULT: "risposta parziale" }));
    expect(reports()[0]).toMatchObject({ status: "done", content: "risposta parziale" });
    casello.requests.length = 0;
    await runTurn(pkg(), ctx("turn-maxturns", [], {}, { FAKE_RESULT: "" }));
    expect(reports()[0]).toMatchObject({ status: "failed", errorCode: "claude_failed" });
  });

  it("timeout: SIGTERM poi SIGKILL, report timeout", async () => {
    const t0 = Date.now();
    await runTurn(pkg({ timeoutMs: 200 }), ctx("stubborn"));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(reports()).toEqual([expect.objectContaining({ status: "failed", errorCode: "timeout" })]);
  });

  it("stop del nodo: report stopped", async () => {
    const ac = new AbortController();
    const p = runTurn(pkg(), ctx("sleep", [], { signal: ac.signal }));
    setTimeout(() => ac.abort(), 150);
    await p;
    expect(reports()).toEqual([expect.objectContaining({ status: "failed", errorCode: "stopped" })]);
    expect(await readdir(turnsDir)).toEqual([]);
  });

  it("409 su ping: claude terminato, nessun report", async () => {
    casello.on("POST", "/api/node/turns/:id/ping", (_req, res) => json(res, 409, { error: "lease non valida o scaduta" }));
    const t0 = Date.now();
    await runTurn(pkg(), ctx("sleep", [], { pingIntervalMs: 50 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(reports()).toEqual([]);
    expect(await readdir(turnsDir)).toEqual([]);
  });

  it("409 sul report: nessun nuovo tentativo, cartella cancellata", async () => {
    casello.on("POST", "/api/node/turns/:id/report", (_req, res) => json(res, 409, { error: "lease non valida o scaduta" }));
    await runTurn(pkg(), ctx("turn"));
    expect(reports()).toHaveLength(1);
    expect(await readdir(turnsDir)).toEqual([]);
  });

  it("claude non avviabile: claude_failed", async () => {
    const c = ctx("turn", [], {
      spawn: (_cmd: string, _args: readonly string[], opts: SpawnOptions) =>
        spawn("/inesistente/claude", [], opts),
    });
    await runTurn(pkg(), c);
    expect(reports()).toEqual([expect.objectContaining({ status: "failed", errorCode: "claude_failed" })]);
    expect(existsSync(turnsDir) ? await readdir(turnsDir) : []).toEqual([]);
  });
});
