import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaselloClient, type TurnPackage } from "./client";
import { createLogger } from "./log";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, fakeSpawn, tempDir, testConfig } from "./test/helpers";
import { startTurnLoop, type TurnLoop } from "./turns";

let casello: FakeCasello;
let base: string;
let cleanup: () => Promise<void>;
let loop: TurnLoop | null;

beforeEach(async () => {
  ({ dir: base, cleanup } = await tempDir());
  casello = new FakeCasello();
  await casello.start();
  loop = null;
  casello.on("POST", "/api/node/turns/:id/ping", (_req, res) =>
    json(res, 200, { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }),
  );
  casello.on("POST", "/api/node/turns/:id/report", (_req, res) => json(res, 204));
});
afterEach(async () => {
  await loop?.stop();
  await casello.close();
  await cleanup();
});

function pkg(id: number): TurnPackage {
  return {
    id,
    leaseToken: `lease-${id}`,
    model: "sonnet",
    systemPrompt: "s",
    prompt: "p",
    mcpUrl: "http://127.0.0.1:9/mcp/turn",
    turnToken: "cat_x",
    maxTurns: 4,
    timeoutMs: 60_000,
  };
}

function start(mode: string, over: { maxConcurrentTurns?: number; errorWaitMs?: number; disabledWaitMs?: number } = {}) {
  loop = startTurnLoop({
    config: testConfig({ caselloUrl: casello.url, maxConcurrentTurns: over.maxConcurrentTurns ?? 2 }),
    client: new CaselloClient({ baseUrl: casello.url, token: FAKE_TOKEN, sleep: async () => {} }),
    logger: createLogger({ dir: path.join(base, "logs"), stdout: false }),
    turnsDir: path.join(base, "turns"),
    spawn: fakeSpawn(mode, [], { FAKE_CLAUDE_DELAY_MS: "400" }),
    errorWaitMs: over.errorWaitMs ?? 50,
    disabledWaitMs: over.disabledWaitMs ?? 50,
    killGraceMs: 200,
  });
  return loop;
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error("condizione non raggiunta in tempo");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const claims = () => casello.calls("POST", "/api/node/turns/claim");
const reports = () => casello.requests.filter((r) => r.method === "POST" && r.path.endsWith("/report"));

describe("startTurnLoop", () => {
  it("all'avvio toglie la cartella dei turni rimasta da un arresto improvviso, prima del primo claim", async () => {
    const leftover = path.join(base, "turns", "turno-vecchio");
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, "mcp.json"), "{\"token\":\"cat_vecchio\"}");
    let dirAtClaim: boolean | null = null;
    casello.on("POST", "/api/node/turns/claim", async (_req, res) => {
      dirAtClaim ??= existsSync(leftover);
      await new Promise((r) => setTimeout(r, 50));
      json(res, 204);
    });
    start("turn");
    await waitFor(() => claims().length > 0);
    expect(dirAtClaim).toBe(false);
    expect(existsSync(path.join(base, "turns"))).toBe(false);
  });

  it("con maxConcurrentTurns 2 e tre turni disponibili ne esegue al più due insieme", async () => {
    const queue = [pkg(1), pkg(2), pkg(3)];
    casello.on("POST", "/api/node/turns/claim", async (_req, res) => {
      const next = queue.shift();
      if (next) return json(res, 200, next);
      await new Promise((r) => setTimeout(r, 100));
      json(res, 204);
    });
    let peak = 0;
    const l = start("turn-slow");
    const watcher = setInterval(() => {
      peak = Math.max(peak, l.running().length);
    }, 5);
    try {
      await waitFor(() => reports().length === 3);
    } finally {
      clearInterval(watcher);
    }
    expect(peak).toBe(2);
    expect(reports().map((r) => r.path).sort()).toEqual([
      "/api/node/turns/1/report",
      "/api/node/turns/2/report",
      "/api/node/turns/3/report",
    ]);
    expect(reports().every((r) => (r.body as { status: string }).status === "done")).toBe(true);
    // la cartella si cancella dopo il report: si attende la fine dei turni
    await waitFor(() => l.running().length === 0);
    expect(await readdir(path.join(base, "turns"))).toEqual([]);
  });

  it("con i posti pieni non fa claim; con un posto libero ne riparte uno", async () => {
    let served = 0;
    casello.on("POST", "/api/node/turns/claim", async (_req, res) => {
      served += 1;
      if (served === 1) return json(res, 200, pkg(1));
      await new Promise((r) => setTimeout(r, 30));
      json(res, 204);
    });
    start("turn-slow", { maxConcurrentTurns: 1 });
    await waitFor(() => reports().length === 1);
    // il primo claim ha preso il turno, nessun altro prima della sua fine
    const first = reports()[0].at;
    expect(claims().filter((c) => c.at < first - 50)).toHaveLength(1);
    await waitFor(() => claims().length >= 2);
  });

  it("204 → nuovo claim subito, senza attese", async () => {
    casello.on("POST", "/api/node/turns/claim", (_req, res) => json(res, 204));
    start("turn", { errorWaitMs: 5_000 });
    await waitFor(() => claims().length >= 5, 2_000);
  });

  it("errore di rete o 5xx: attende errorWaitMs prima di riprovare", async () => {
    casello.on("POST", "/api/node/turns/claim", (_req, res) => json(res, 502, { error: "x" }));
    start("turn", { errorWaitMs: 300 });
    await waitFor(() => claims().length >= 2);
    const [a, b] = claims();
    expect(b.at - a.at).toBeGreaterThanOrEqual(250);
  });

  it("403: attende disabledWaitMs e registra una volta sola", async () => {
    casello.on("POST", "/api/node/turns/claim", (_req, res) => json(res, 403, { error: "nodo disattivato" }));
    start("turn", { disabledWaitMs: 100 });
    await waitFor(() => claims().length >= 3);
    const log = (await readdir(path.join(base, "logs"))).length;
    expect(log).toBeGreaterThan(0);
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path.join(base, "logs", "casello-nodo.log"), "utf8");
    expect(text.match(/nodo disattivato/g)).toHaveLength(1);
  });

  it("stop: interrompe il claim in attesa e il turno in corso (report stopped)", async () => {
    let served = 0;
    casello.on("POST", "/api/node/turns/claim", async (_req, res) => {
      served += 1;
      if (served === 1) return json(res, 200, pkg(1));
      await new Promise((r) => setTimeout(r, 20_000));
      json(res, 204);
    });
    const l = start("sleep");
    await waitFor(() => l.running().length === 1);
    await waitFor(() => claims().length >= 2);
    const t0 = Date.now();
    await l.stop();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(reports()).toHaveLength(1);
    expect(reports()[0].body).toMatchObject({ status: "failed", errorCode: "stopped" });
    loop = null;
  });
});
