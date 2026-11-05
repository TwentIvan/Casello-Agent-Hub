import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaselloClient } from "./client";
import { startLoop, type LoopDeps } from "./loop";
import { readState } from "./state";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, fakeSpawn, taskPackage, tempDir, testConfig } from "./test/helpers";
import type { Config } from "./config";

let casello: FakeCasello;
let base: string;
let root: string;
let logsDir: string;
let statePath: string;
let cleanup: () => Promise<void>;
let stops: Array<() => Promise<void>>;

beforeEach(async () => {
  ({ dir: base, cleanup } = await tempDir());
  root = path.join(base, "radice");
  logsDir = path.join(base, "logs");
  statePath = path.join(base, "stato", "state.json");
  await mkdir(path.join(root, "progetto"), { recursive: true });
  await mkdir(path.join(base, "skills", "sap-code-review"), { recursive: true });
  await writeFile(path.join(base, "skills", "sap-code-review", "SKILL.md"), "# skill");
  casello = new FakeCasello();
  await casello.start();
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) await stop();
  await casello.close();
  await cleanup();
});

function config(over: Partial<Config> = {}): Config {
  return testConfig({
    caselloUrl: casello.url,
    workspaceRoot: root,
    skillsDirs: [path.join(base, "skills")],
    ...over,
  });
}

function start(cfg: Config, mode: string, over: Partial<LoopDeps> = {}) {
  const loop = startLoop(cfg, {
    client: new CaselloClient({ baseUrl: casello.url, token: FAKE_TOKEN, sleep: async () => {} }),
    spawn: fakeSpawn(mode),
    logsDir,
    logToStdout: process.env.DEBUG_NODO === "1",
    statePath,
    heartbeatIntervalMs: 50,
    pingIntervalMs: 60_000,
    reportRetryMs: 20,
    ...over,
  });
  stops.push(() => loop.stop());
  return loop;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error("condizione non raggiunta in tempo");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Un compito in attesa, consegnato una volta sola. */
function oneTask(pkg = taskPackage()) {
  let given = false;
  casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: given ? 0 : 1 }));
  casello.on("POST", "/api/node/claim", (_req, res) => {
    if (given) return json(res, 204);
    given = true;
    json(res, 200, pkg);
  });
}

async function allLogs(): Promise<string> {
  const files = await readdir(logsDir);
  const parts = await Promise.all(files.map((f) => readFile(path.join(logsDir, f), "utf8")));
  return parts.join("\n");
}

describe("startLoop", () => {
  it("ciclo completo: heartbeat, claim, esecuzione, report done con l'esito dal file", async () => {
    oneTask();
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    start(config(), "esito");
    await waitFor(() => casello.calls("POST", "/api/node/tasks/42/report").length > 0);

    const [hb] = casello.calls("POST", "/api/node/heartbeat");
    expect(hb.body).toEqual({
      version: "0.1.0",
      executor: "claude-code",
      skills: ["sap-code-review"],
      workspaceRoot: root,
      maxConcurrent: 1,
      folders: expect.any(Array),
    });
    const [report] = casello.calls("POST", "/api/node/tasks/42/report");
    expect(report.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(report.body).toMatchObject({ leaseToken: "lease-abc", status: "done", outcome: "fatto dal file" });

    await waitFor(async () => (await readState(statePath))?.tasks.length === 0);
    const state = await readState(statePath);
    expect(state?.lastHeartbeatAt).toBeTruthy();
  });

  it("i log non contengono il token, le istruzioni o l'output della CLI", async () => {
    oneTask();
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    start(config(), "cli");
    await waitFor(() => casello.calls("POST", "/api/node/tasks/42/report").length > 0);
    const logs = await allLogs();
    expect(logs).toContain("compito 42");
    expect(logs).not.toContain(FAKE_TOKEN);
    expect(logs).not.toContain("lease-abc");
    expect(logs).not.toContain("ISTRUZIONI SEGRETE DEL COMPITO");
    expect(logs).not.toContain("risultato della CLI");
    const state = await readFile(statePath, "utf8");
    expect(state).not.toContain(FAKE_TOKEN);
  });

  it("lo stato elenca il compito in corso", async () => {
    oneTask();
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    process.env.FAKE_CLAUDE_DELAY_MS = "600";
    try {
      start(config(), "slow");
      await waitFor(async () => (await readState(statePath))?.tasks.length === 1);
      const state = await readState(statePath);
      expect(state?.tasks[0]).toMatchObject({ taskId: 42 });
      expect(Date.parse(state?.tasks[0].startedAt ?? "")).not.toBeNaN();
      await waitFor(() => casello.calls("POST", "/api/node/tasks/42/report").length > 0);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it("spazio di lavoro null → report blocked «spazio di lavoro non valido»", async () => {
    oneTask(taskPackage({ workspace: null }));
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    start(config(), "esito");
    await waitFor(() => casello.calls("POST", "/api/node/tasks/42/report").length > 0);
    expect(casello.calls("POST", "/api/node/tasks/42/report")[0].body).toMatchObject({
      status: "blocked",
      outcome: "spazio di lavoro non valido",
    });
  });

  it("un errore di rete al report viene ritentato", async () => {
    oneTask();
    let n = 0;
    casello.on("POST", "/api/node/tasks/:id/report", (req, res) => {
      n++;
      if (n === 1) {
        res.socket?.destroy();
        return;
      }
      json(res, 204);
    });
    start(config(), "esito");
    await waitFor(() => n >= 2);
    const reports = casello.calls("POST", "/api/node/tasks/42/report");
    expect(reports.length).toBe(2);
    expect(reports[1].body).toMatchObject({ status: "done" });
  });

  it("report ritentato oltre i tentativi del client finché la lease è valida", async () => {
    oneTask();
    let n = 0;
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => {
      n++;
      json(res, n < 30 ? 503 : 204);
    });
    start(config(), "esito");
    await waitFor(() => n >= 30);
    await new Promise((r) => setTimeout(r, 100));
    expect(n).toBe(30);
  });

  it("report con lease scaduta (409) non viene ritentato", async () => {
    oneTask();
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) =>
      json(res, 409, { error: "lease non valida o scaduta" }),
    );
    start(config(), "esito");
    await waitFor(() => casello.calls("POST", "/api/node/tasks/42/report").length > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(casello.calls("POST", "/api/node/tasks/42/report")).toHaveLength(1);
    await waitFor(async () => (await readState(statePath))?.tasks.length === 0);
  });

  for (const status of [401, 403]) {
    it(`report con ${status} non viene ritentato (lease persa)`, async () => {
      oneTask();
      casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, status, { error: "nodo disattivato" }));
      start(config(), "esito", { reportRetryMs: 10 });
      await waitFor(() => casello.calls("POST", "/api/node/tasks/42/report").length > 0);
      await new Promise((r) => setTimeout(r, 200));
      expect(casello.calls("POST", "/api/node/tasks/42/report")).toHaveLength(1);
      await waitFor(async () => (await readState(statePath))?.tasks.length === 0);
    });
  }

  it("rispetta maxConcurrent", async () => {
    let id = 100;
    let reports = 0;
    let maxInFlight = 0;
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 5 }));
    casello.on("POST", "/api/node/claim", (_req, res) => {
      const inFlight = id - 100 + 1 - reports;
      maxInFlight = Math.max(maxInFlight, inFlight);
      json(res, 200, taskPackage({ taskId: id, workspace: `progetto-${id++}` }));
    });
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => {
      reports++;
      json(res, 204);
    });
    for (let i = 100; i < 120; i++) await mkdir(path.join(root, `progetto-${i}`));
    process.env.FAKE_CLAUDE_DELAY_MS = "300";
    try {
      start(config({ maxConcurrent: 2 }), "slow");
      await waitFor(() => reports >= 4, 10_000);
      expect(maxInFlight).toBe(2);
      const bodies = casello.calls("POST", "/api/node/tasks/").map((r) => r.body as { status: string });
      expect(bodies.every((b) => b.status === "done")).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it("due compiti nello stesso spazio di lavoro: entrambi done, uno dopo l'altro", async () => {
    let id = 200;
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: id < 202 ? 1 : 0 }));
    casello.on("POST", "/api/node/claim", (_req, res) =>
      id < 202 ? json(res, 200, taskPackage({ taskId: id++ })) : json(res, 204),
    );
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    process.env.FAKE_CLAUDE_DELAY_MS = "300";
    try {
      start(config({ maxConcurrent: 2 }), "slow");
      await waitFor(
        () => casello.calls("POST", "/api/node/tasks/").filter((r) => r.path.endsWith("/report")).length === 2,
      );
      const bodies = casello.calls("POST", "/api/node/tasks/").filter((r) => r.path.endsWith("/report"));
      expect(bodies.map((r) => (r.body as { status: string }).status)).toEqual(["done", "done"]);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
  });

  it("nessun claim se pending è 0", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0 }));
    start(config(), "esito");
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 3);
    expect(casello.calls("POST", "/api/node/claim")).toHaveLength(0);
  });

  it("un heartbeat rifiutato finisce nello stato come ultimo errore", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 403, { error: "nodo disattivato" }));
    start(config(), "esito");
    await waitFor(async () => Boolean((await readState(statePath))?.lastError));
    const state = await readState(statePath);
    expect(state?.lastError).toContain("nodo disattivato");
    expect(state?.lastHeartbeatAt).toBeNull();
  });

  it("ping con 409: compito interrotto e nessun report inviato", async () => {
    oneTask();
    casello.on("POST", "/api/node/tasks/:id/ping", (_req, res) =>
      json(res, 409, { error: "lease non valida o scaduta" }),
    );
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) =>
      json(res, 409, { error: "lease non valida o scaduta" }),
    );
    start(config(), "sleep", { pingIntervalMs: 50 });
    await waitFor(() => casello.calls("POST", "/api/node/tasks/42/ping").length > 0);
    await waitFor(async () => (await readState(statePath))?.tasks.length === 0);
    expect(casello.calls("POST", "/api/node/tasks/42/report")).toHaveLength(0);
    expect((await readState(statePath))?.lastError).toBeNull();
  });

  it("stop() interrompe il compito in corso e lo riferisce failed", async () => {
    oneTask();
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    const loop = start(config(), "sleep", { killGraceMs: 100 });
    await waitFor(async () => (await readState(statePath))?.tasks.length === 1);
    const started = Date.now();
    await loop.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(casello.calls("POST", "/api/node/tasks/42/report")[0].body).toMatchObject({
      status: "failed",
      outcome: "esecuzione interrotta: nodo fermato",
    });
  });

  it("stop() ferma gli heartbeat", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0 }));
    const loop = start(config(), "esito");
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 1);
    await loop.stop();
    const count = casello.calls("POST", "/api/node/heartbeat").length;
    await new Promise((r) => setTimeout(r, 200));
    expect(casello.calls("POST", "/api/node/heartbeat").length).toBe(count);
  });
});
