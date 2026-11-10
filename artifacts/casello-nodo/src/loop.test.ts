import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaselloClient, type TurnPackage } from "./client";
import { startLoop, type LoopDeps } from "./loop";
import { readState } from "./state";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, fakeSpawn, taskPackage, tempDir, testConfig } from "./test/helpers";
import type { Config } from "./config";
import { NODE_VERSION } from "./capabilities";
import { updatePaths, type UpdatePaths } from "./updater";

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
      version: NODE_VERSION,
      kind: "cli",
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

describe("aggiornamenti, impostazioni, diagnosi e disinstallazione", () => {
  const OLD = Buffer.from("programma vecchio\n");
  const NEW = Buffer.from("programma nuovo\n".repeat(20));
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const DOWNLOAD = "/downloads/nodo/casello-nodo-9.9.9";
  let upd: UpdatePaths;

  beforeEach(async () => {
    upd = updatePaths(path.join(base, "home"));
    await mkdir(path.dirname(upd.programPath), { recursive: true });
    await writeFile(upd.programPath, OLD, { mode: 0o755 });
    casello.on("GET", DOWNLOAD, (_req, res) => {
      res.statusCode = 200;
      res.end(NEW);
    });
  });

  const update = (over: Record<string, unknown> = {}) => ({
    version: "9.9.9",
    sha256: sha(NEW),
    size: NEW.length,
    required: false,
    ...over,
  });
  const downloads = () => casello.calls("GET", DOWNLOAD).length;
  const appDeps = (over: Partial<LoopDeps> = {}): Partial<LoopDeps> => ({
    kind: "app",
    updatePaths: upd,
    exit: vi.fn(),
    drainPollMs: 20,
    ...over,
  });

  function turnPkg(id: number): TurnPackage {
    return {
      id,
      leaseToken: `lease-t${id}`,
      model: "sonnet",
      systemPrompt: "s",
      prompt: "p",
      mcpUrl: "http://127.0.0.1:9/mcp/turn",
      turnToken: "cat_x",
      maxTurns: 4,
      timeoutMs: 60_000,
    };
  }

  it("heartbeat con kind «app» e la versione fallita letta da update.json", async () => {
    await writeFile(upd.updateJsonPath, JSON.stringify({ failedVersion: "9.9.9", from: NODE_VERSION, to: "9.9.9" }));
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0, update: update() }));
    start(config(), "esito", appDeps());
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 3);
    expect(casello.calls("POST", "/api/node/heartbeat")[0].body).toMatchObject({ kind: "app", updateFailed: "9.9.9" });
    // La versione fallita non si riprova
    expect(downloads()).toBe(0);
  });

  it("primo heartbeat riuscito → update.json dell'aggiornamento chiuso", async () => {
    await writeFile(upd.updateJsonPath, JSON.stringify({ from: "0.2.0", to: NODE_VERSION, startedAt: new Date().toISOString(), starts: 1 }));
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0 }));
    start(config(), "esito", appDeps());
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 1);
    await waitFor(async () => !(await readdir(path.dirname(upd.updateJsonPath))).includes("update.json"));
  });

  it("update non obbligatorio con un compito in corso: scarica solo a compito finito, poi sostituisce ed esce con 0", async () => {
    let given = false;
    let downloadsAtReport = -1;
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: given ? 0 : 1, update: update() }));
    casello.on("POST", "/api/node/claim", (_req, res) => {
      if (given) return json(res, 204);
      given = true;
      json(res, 200, taskPackage());
    });
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => {
      downloadsAtReport = downloads();
      json(res, 204);
    });
    const exit = vi.fn();
    process.env.FAKE_CLAUDE_DELAY_MS = "500";
    try {
      start(config(), "slow", appDeps({ exit }));
      await waitFor(() => exit.mock.calls.length > 0);
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
    expect(downloadsAtReport).toBe(0);
    expect(casello.calls("POST", "/api/node/tasks/42/report")[0].body).toMatchObject({ status: "done" });
    expect(exit).toHaveBeenCalledWith(0);
    expect(await readFile(upd.programPath)).toEqual(NEW);
    expect(await readFile(upd.prevPath)).toEqual(OLD);
    await new Promise((r) => setTimeout(r, 200));
    expect(downloads()).toBe(1);
  });

  it("sha256 diverso → programma intatto e nuovo tentativo non prima di un'ora", async () => {
    let now = new Date("2026-11-10T10:00:00.000Z").getTime();
    casello.on("POST", "/api/node/heartbeat", (_req, res) =>
      json(res, 200, { pending: 0, update: update({ sha256: "f".repeat(64) }) }),
    );
    const exit = vi.fn();
    start(config(), "esito", appDeps({ exit, now: () => new Date(now) }));
    await waitFor(() => downloads() === 1);
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 6);
    expect(downloads()).toBe(1);
    now += 59 * 60_000;
    await new Promise((r) => setTimeout(r, 200));
    expect(downloads()).toBe(1);
    now += 2 * 60_000;
    await waitFor(() => downloads() === 2);
    expect(await readFile(upd.programPath)).toEqual(OLD);
    expect(exit).not.toHaveBeenCalled();
  });

  it("update obbligatorio con lavoro oltre 30 minuti (orologio finto) → compito interrotto come uno stop, poi aggiornamento", async () => {
    let now = Date.parse("2026-11-10T10:00:00.000Z");
    let given = false;
    casello.on("POST", "/api/node/heartbeat", (_req, res) =>
      json(res, 200, { pending: given ? 0 : 1, ...(given ? { update: update({ required: true }) } : {}) }),
    );
    casello.on("POST", "/api/node/claim", (_req, res) => {
      if (given) return json(res, 204);
      given = true;
      json(res, 200, taskPackage());
    });
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    const exit = vi.fn();
    start(
      config(),
      "sleep",
      appDeps({
        exit,
        killGraceMs: 100,
        now: () => new Date(now),
        // Ogni attesa del drenaggio fa passare 5 minuti
        sleep: async () => {
          now += 5 * 60_000;
          await new Promise((r) => setTimeout(r, 5));
        },
      }),
    );
    await waitFor(() => exit.mock.calls.length > 0, 10_000);
    expect(casello.calls("POST", "/api/node/tasks/42/report")[0].body).toMatchObject({
      status: "failed",
      outcome: "esecuzione interrotta: nodo fermato",
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(await readFile(upd.programPath)).toEqual(NEW);
  });

  it("nodo installato con la CLI che riceve update → ignorato", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0, update: update({ required: true }) }));
    const exit = vi.fn();
    start(config(), "esito", { updatePaths: upd, exit });
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 3);
    expect(downloads()).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    expect(await readFile(upd.programPath)).toEqual(OLD);
  });

  it("settings dal server: posti dei compiti nell'heartbeat; null → torna alla config locale", async () => {
    let settings: Record<string, unknown> | null = { maxConcurrent: 3, maxConcurrentTurns: null, taskTimeoutMinutes: 10 };
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0, ...(settings ? { settings } : {}) }));
    start(config({ maxConcurrent: 1 }), "esito");
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 2);
    expect(casello.calls("POST", "/api/node/heartbeat").at(-1)?.body).toMatchObject({ maxConcurrent: 3 });
    settings = { maxConcurrent: null, maxConcurrentTurns: null, taskTimeoutMinutes: null };
    const n = casello.calls("POST", "/api/node/heartbeat").length;
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= n + 2);
    expect(casello.calls("POST", "/api/node/heartbeat").at(-1)?.body).toMatchObject({ maxConcurrent: 1 });
  });

  it("settings {maxConcurrentTurns: 1} → un solo claim di turno in attesa; null → di nuovo due posti", async () => {
    let settings: Record<string, unknown> = { maxConcurrent: null, maxConcurrentTurns: 1, taskTimeoutMinutes: null };
    const turnsToGive = [1, 2];
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0, settings }));
    casello.on("POST", "/api/node/turns/claim", async (_req, res) => {
      // Il primo turno si consegna solo dopo che le impostazioni del primo heartbeat sono applicate
      await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 1);
      await new Promise((r) => setTimeout(r, 50));
      const id = turnsToGive.shift();
      if (id !== undefined) return json(res, 200, turnPkg(id));
      await new Promise((r) => setTimeout(r, 30));
      json(res, 204);
    });
    casello.on("POST", "/api/node/turns/:id/ping", (_req, res) =>
      json(res, 200, { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }),
    );
    const claimsAtReport: number[] = [];
    casello.on("POST", "/api/node/turns/:id/report", (_req, res) => {
      claimsAtReport.push(casello.calls("POST", "/api/node/turns/claim").length);
      // Dopo il primo turno le impostazioni tornano alla config locale (2 posti)
      settings = { maxConcurrent: null, maxConcurrentTurns: null, taskTimeoutMinutes: null };
      json(res, 204);
    });
    start(config({ maxConcurrentTurns: 2 }), "turn-slow", {
      spawn: fakeSpawn("turn-slow", [], { FAKE_CLAUDE_DELAY_MS: "400" }),
      turnsDir: path.join(base, "turns"),
    });
    await waitFor(() => claimsAtReport.length === 2, 10_000);
    // Primo turno: nessun altro claim mentre è in corso
    expect(claimsAtReport[0]).toBe(1);
    // Secondo turno (posti di nuovo 2): i claim continuano mentre è in corso
    expect(claimsAtReport[1]).toBeGreaterThan(2);
  });

  it("diagnosticsRequested → una sola diagnosi inviata, senza il token", async () => {
    let requested = true;
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 0, diagnosticsRequested: requested }));
    casello.on("POST", "/api/node/diagnostics", async (_req, res) => {
      await new Promise((r) => setTimeout(r, 200));
      requested = false;
      json(res, 204);
    });
    start(config(), "esito", { osVersion: async () => "15.1" });
    await waitFor(() => casello.calls("POST", "/api/node/diagnostics").length === 1);
    await waitFor(() => !requested);
    await new Promise((r) => setTimeout(r, 200));
    const sent = casello.calls("POST", "/api/node/diagnostics");
    expect(sent).toHaveLength(1);
    const content = (sent[0].body as { content: string }).content;
    expect(content).toContain("15.1");
    expect(JSON.stringify(sent[0].body)).not.toContain(FAKE_TOKEN);
  });

  it("uninstallRequested → disinstallazione chiamata una volta, nessun lavoro preso", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 3, uninstallRequested: true }));
    const onUninstallRequested = vi.fn();
    start(config(), "esito", { onUninstallRequested });
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 3);
    expect(onUninstallRequested).toHaveBeenCalledTimes(1);
    expect(casello.calls("POST", "/api/node/claim")).toHaveLength(0);
  });

  for (const status of [401, 403]) {
    it(`heartbeat ${status} in modalità app → una sola notifica, nessun lavoro, nuovi tentativi, nessuna uscita`, async () => {
      casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, status, { error: "token non valido" }));
      const notify = vi.fn(async () => {});
      const exit = vi.fn();
      start(config(), "esito", appDeps({ notify, exit }));
      await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 4);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith("Botcave Nodo non è più collegato: aprilo e scegli Ricollega");
      expect(casello.calls("POST", "/api/node/claim")).toHaveLength(0);
      expect(exit).not.toHaveBeenCalled();
    });
  }

  it("heartbeat 401 con la CLI → nessuna notifica", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 401, { error: "token non valido" }));
    const notify = vi.fn(async () => {});
    start(config(), "esito", { notify });
    await waitFor(() => casello.calls("POST", "/api/node/heartbeat").length >= 3);
    expect(notify).not.toHaveBeenCalled();
  });
});
