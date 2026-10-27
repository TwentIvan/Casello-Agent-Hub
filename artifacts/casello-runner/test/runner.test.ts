import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, runRunner, type RunnerOptions } from "../src/runner";

// Ciclo del runner contro un finto Casello che implementa il protocollo /api/runner (attesa lunga, segnale di vita,
// fine del compito) e registra l'ordine delle richieste. Claude è il finto `claude` (fake-claude.mjs).

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const MACHINE_TOKEN = "csl_m_TOKEN_DI_MACCHINA_SEGRETO";
const PROMPT = "PROMPT_RISERVATO_DEL_COMPITO";

type Delivery = { jobId: number; itemId: string; jobToken: string; prompt: string; resumeSessionId: string | null; mcpUrl: string };

let server: http.Server;
let base: string;
let events: string[];
let auths: string[];
let doneBodies: Record<string, unknown>[];
let queue: Delivery[];
let heartbeatStatus: number;
/** Richieste a /next da far cadere (errore di rete) prima di rispondere. */
let dropNext: number;
let nextStatus: number | null;
let logs: string[];
let scratch: string;
let record: string;
const savedEnv = { ...process.env };

const delivery = (n: number, over: Partial<Delivery> = {}): Delivery => ({
  jobId: n,
  itemId: `item-${n}`,
  jobToken: `csl_j_TOKEN_LAVORO_${n}`,
  prompt: PROMPT,
  resumeSessionId: null,
  mcpUrl: "https://casello.example/api/mcp",
  ...over,
});

function records(): any[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

let ac: AbortController;
let running: Promise<void> | null;

function start(over: Partial<RunnerOptions> = {}): Promise<void> {
  running = runRunner({
    url: base,
    token: MACHINE_TOKEN,
    bin: FAKE_CLAUDE,
    signal: ac.signal,
    log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
    ...over,
  });
  return running;
}

beforeEach(async () => {
  events = [];
  auths = [];
  doneBodies = [];
  queue = [];
  heartbeatStatus = 204;
  dropNext = 0;
  nextStatus = null;
  logs = [];
  running = null;
  ac = new AbortController();
  scratch = mkdtempSync(join(tmpdir(), "runner-test-"));
  record = join(scratch, "record.jsonl");
  process.env["FAKE_CLAUDE_RECORD"] = record;
  process.env["FAKE_CLAUDE_MODE"] = "record";
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      auths.push(String(req.headers.authorization));
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/runner/next") {
        events.push("next");
        if (dropNext > 0) {
          dropNext--;
          req.socket.destroy();
          return;
        }
        if (nextStatus !== null) {
          res.statusCode = nextStatus;
          res.end(JSON.stringify({ error: "token non valido o revocato" }));
          return;
        }
        const d = queue.shift();
        if (d) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(d));
        } else {
          setTimeout(() => {
            res.statusCode = 204;
            res.end();
          }, 30);
        }
        return;
      }
      const hb = /^\/api\/runner\/jobs\/(\d+)\/heartbeat$/.exec(url);
      if (req.method === "POST" && hb) {
        events.push(`heartbeat:${hb[1]}`);
        res.statusCode = heartbeatStatus;
        res.end(heartbeatStatus === 204 ? undefined : JSON.stringify({ error: "lavoro scaduto" }));
        return;
      }
      const done = /^\/api\/runner\/items\/([^/]+)\/done$/.exec(url);
      if (req.method === "POST" && done) {
        events.push(`done:${done[1]}`);
        doneBodies.push(JSON.parse(raw));
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  ac.abort();
  await running?.catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  process.env = { ...savedEnv };
  rmSync(scratch, { recursive: true, force: true });
});

describe("runRunner", () => {
  it("per ogni compito: Claude con il token di quella consegna, poi done, solo dopo una nuova attesa", async () => {
    // Lo stesso compito consegnato due volte (es. ripresa): ogni consegna ha un token nuovo
    queue = [delivery(1), delivery(1, { itemId: "item-1b", jobToken: "csl_j_TOKEN_NUOVO", resumeSessionId: "sess-1" }), delivery(2)];
    start();
    await waitFor(() => doneBodies.length === 3);
    await waitFor(() => events.filter((e) => e === "next").length >= 4);

    expect(events.slice(0, 7)).toEqual(["next", "done:item-1", "next", "done:item-1b", "next", "done:item-2", "next"]);
    expect(new Set(auths)).toEqual(new Set([`Bearer ${MACHINE_TOKEN}`]));
    expect(doneBodies[0]).toEqual({ sessionId: expect.stringMatching(/^fake-/), exit: "done", usage: { inputTokens: 15, outputTokens: 5 } });
    expect(doneBodies[1]).toMatchObject({ sessionId: "sess-1", exit: "done" });
    const r = records();
    expect(r.map((x) => x.config.mcpServers.casello.headers.Authorization)).toEqual([
      "Bearer csl_j_TOKEN_LAVORO_1",
      "Bearer csl_j_TOKEN_NUOVO",
      "Bearer csl_j_TOKEN_LAVORO_2",
    ]);
    expect(r[1].args.slice(-2)).toEqual(["--resume", "sess-1"]);
    // mcp.json e cartella rimossi a fine compito
    for (const x of r) expect(existsSync(x.cwd)).toBe(false);
    // Nei log id e durate, mai token né prompt
    const text = logs.join("\n");
    expect(text).toContain("item-1");
    expect(text).not.toContain(MACHINE_TOKEN);
    expect(text).not.toContain("csl_j_");
    expect(text).not.toContain(PROMPT);
  });

  it("con concorrenza 2 due compiti insieme, ognuno con il proprio ordine run → done → next", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    queue = [delivery(1), delivery(2)];
    start({ concurrency: 2, heartbeatMs: 50, killGraceMs: 100 });
    await waitFor(() => records().length === 2);
    ac.abort();
    await running;
    expect(doneBodies.map((b) => b["exit"])).toEqual(["error", "error"]);
    expect(events.filter((e) => e === "next")).toHaveLength(2);
  });

  it("errore di rete: riprova con attesa crescente (prima 1 s)", async () => {
    dropNext = 2;
    queue = [delivery(1)];
    const started = Date.now();
    start();
    await waitFor(() => doneBodies.length === 1, 10_000);
    // 1 s dopo il primo errore, 2 s dopo il secondo
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(events.slice(0, 4)).toEqual(["next", "next", "next", "done:item-1"]);
    expect(logs.some((l) => l.includes("riprovo tra 1 s"))).toBe(true);
    expect(logs.some((l) => l.includes("riprovo tra 2 s"))).toBe(true);
  }, 15_000);

  it("segnale di vita durante il compito; 410 → Claude terminato, done con exit error", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    queue = [delivery(7)];
    start({ heartbeatMs: 50, killGraceMs: 200 });
    await waitFor(() => records().length === 1 && events.includes("heartbeat:7"));
    heartbeatStatus = 410;
    await waitFor(() => doneBodies.length === 1);
    const [r] = records();
    expect(doneBodies[0]).toMatchObject({ exit: "error" });
    expect(() => process.kill(r.pid, 0)).toThrow();
    expect(existsSync(r.cwd)).toBe(false);
    const doneAt = events.indexOf("done:item-7");
    expect(events.slice(doneAt + 1).every((e) => !e.startsWith("heartbeat"))).toBe(true);
  });

  it("arresto (SIGINT/SIGTERM): termina il compito in corso, done con exit error, poi esce", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    queue = [delivery(3)];
    start({ killGraceMs: 100 });
    await waitFor(() => records().length === 1);
    ac.abort();
    await running;
    expect(events).toEqual(["next", "done:item-3"]);
    expect(doneBodies[0]).toMatchObject({ exit: "error" });
  });

  it("token di macchina rifiutato (401): il runner si ferma con un errore", async () => {
    nextStatus = 401;
    await expect(start()).rejects.toThrow("token di macchina non valido o revocato");
    expect(events).toEqual(["next"]);
  });
});

describe("readConfig", () => {
  const env = { CASELLO_URL: "https://casello.example/", CASELLO_RUNNER_TOKEN: MACHINE_TOKEN };

  it("variabili obbligatorie, default di claude e concorrenza", () => {
    expect(readConfig(env)).toEqual({ url: "https://casello.example", token: MACHINE_TOKEN, bin: "claude", concurrency: 1 });
    expect(readConfig({ ...env, CASELLO_CLAUDE_BIN: "/opt/claude", CASELLO_RUNNER_CONCURRENCY: "2" })).toMatchObject({ bin: "/opt/claude", concurrency: 2 });
    expect(readConfig({ ...env, CASELLO_URL: "http://localhost:3000" }).url).toBe("http://localhost:3000");
    expect(readConfig({ ...env, CASELLO_URL: "http://127.0.0.1:3000" }).url).toBe("http://127.0.0.1:3000");
  });

  it("errori: url mancante o non https fuori da localhost, token assente o non di macchina, concorrenza non valida", () => {
    expect(() => readConfig({ CASELLO_RUNNER_TOKEN: MACHINE_TOKEN })).toThrow("CASELLO_URL mancante");
    expect(() => readConfig({ ...env, CASELLO_URL: "http://casello.example" })).toThrow("CASELLO_URL deve essere https");
    expect(() => readConfig({ CASELLO_URL: env.CASELLO_URL })).toThrow("CASELLO_RUNNER_TOKEN");
    expect(() => readConfig({ ...env, CASELLO_RUNNER_TOKEN: "csl_p_personale" })).toThrow("CASELLO_RUNNER_TOKEN");
    expect(() => readConfig({ ...env, CASELLO_RUNNER_CONCURRENCY: "0" })).toThrow("CASELLO_RUNNER_CONCURRENCY");
    // Il messaggio non riporta mai il token
    try {
      readConfig({ ...env, CASELLO_RUNNER_TOKEN: "csl_p_personale" });
    } catch (err) {
      expect((err as Error).message).not.toContain("csl_p_personale");
    }
  });
});
