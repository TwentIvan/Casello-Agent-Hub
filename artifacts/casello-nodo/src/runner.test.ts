import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaselloClient } from "./client";
import { isLeaseLostReport, runTask, WorkspaceQueue, type RunContext } from "./runner";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, fakeSpawn, taskPackage, tempDir, testConfig, type SpawnCall } from "./test/helpers";

let casello: FakeCasello;
let base: string;
let root: string;
let ws: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir: base, cleanup } = await tempDir());
  root = path.join(base, "radice");
  ws = path.join(root, "progetto");
  await mkdir(ws, { recursive: true });
  casello = new FakeCasello();
  await casello.start();
  casello.on("POST", "/api/node/tasks/:id/ping", (_req, res) =>
    json(res, 200, { leaseExpiresAt: new Date(Date.now() + 900_000).toISOString() }),
  );
});
afterEach(async () => {
  await casello.close();
  await cleanup();
});

function ctx(mode: string, calls: SpawnCall[] = [], over: Partial<RunContext> = {}): RunContext {
  const config = testConfig({ caselloUrl: casello.url, workspaceRoot: root });
  return {
    config,
    client: new CaselloClient({ baseUrl: casello.url, token: FAKE_TOKEN, sleep: async () => {} }),
    spawn: fakeSpawn(mode, calls),
    pingIntervalMs: 60_000,
    killGraceMs: 200,
    workspaceQueue: new WorkspaceQueue(),
    ...over,
  };
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

describe("runTask", () => {
  it("esito dal file casello-esito.json, costo e token dalla CLI", async () => {
    const calls: SpawnCall[] = [];
    process.env.CASELLO_TOKEN = FAKE_TOKEN;
    try {
      const report = await runTask(taskPackage(), ctx("esito", calls));
      expect(calls).toHaveLength(1);
      const [call] = calls;
      const sessionId = call.args[call.args.indexOf("--session-id") + 1];
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(call.command).toBe("claude");
      expect(call.args).toEqual([
        "-p",
        "--output-format",
        "json",
        "--session-id",
        sessionId,
        "--dangerously-skip-permissions",
        "Leggi casello-compito.md in questa cartella ed eseguilo.",
      ]);
      expect(await realCwd(call)).toBe(await realCwd({ options: { cwd: ws } } as SpawnCall));
      const env = call.options.env ?? {};
      expect(Object.keys(env).filter((k) => k.startsWith("CASELLO_"))).toEqual([]);
      expect(Object.values(env)).not.toContain(FAKE_TOKEN);
      expect(report).toEqual({
        leaseToken: "lease-abc",
        status: "done",
        outcome: "fatto dal file",
        detail: "dettaglio dal file",
        costUsd: 0.25,
        promptTokens: 125,
        completionTokens: 40,
        sessionId,
      });
      expect(existsSync(path.join(ws, "casello-compito.md"))).toBe(false);
      expect(existsSync(path.join(ws, "casello-esito.json"))).toBe(false);
    } finally {
      delete process.env.CASELLO_TOKEN;
    }
  });

  it("modalità dei permessi diversa da bypassPermissions → --permission-mode", async () => {
    const calls: SpawnCall[] = [];
    const c = ctx("esito", calls);
    c.config = { ...c.config, permissionMode: "acceptEdits", claudeBin: "/opt/claude" };
    await runTask(taskPackage(), c);
    expect(calls[0].command).toBe("/opt/claude");
    expect(calls[0].args.slice(5, 7)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(calls[0].args).not.toContain("--dangerously-skip-permissions");
  });

  it("casello-compito.md contiene istruzioni, PLAN, skill e la richiesta dell'esito", async () => {
    let content = "";
    const inner = fakeSpawn("esito");
    const c = ctx("esito", [], {
      spawn: (cmd, args, opts) => {
        content = readFileSync(path.join(String(opts.cwd), "casello-compito.md"), "utf8");
        return inner(cmd, args, opts);
      },
    });
    await runTask(taskPackage(), c);
    for (const piece of [
      "ISTRUZIONI SEGRETE DEL COMPITO",
      "Obiettivo della squadra",
      "vincolo uno",
      "Creare il branch",
      "Scrivi in modo chiaro.",
      "sap-code-review",
      "Sviluppatore",
      "casello-esito.json",
      "verifica",
    ]) {
      expect(content).toContain(piece);
    }
  });

  it("esito dalla CLI se il file manca, troncato a 300 caratteri", async () => {
    const report = await runTask(taskPackage(), ctx("cli"));
    expect(report.status).toBe("done");
    expect(report.outcome.length).toBe(300);
    expect(report.outcome.startsWith("risultato della CLI")).toBe(true);
    expect(report.detail?.startsWith("risultato della CLI")).toBe(true);
    expect(report.costUsd).toBe(0.25);
  });

  it.each([
    ["null", null],
    ["fuori dalla radice", "../fuori"],
    ["inesistente", "manca"],
  ])("spazio di lavoro %s → blocked", async (_name, workspace) => {
    await mkdir(path.join(base, "fuori"), { recursive: true });
    const calls: SpawnCall[] = [];
    const report = await runTask(taskPackage({ workspace }), ctx("esito", calls));
    expect(report).toMatchObject({
      status: "blocked",
      outcome: "spazio di lavoro non valido",
      leaseToken: "lease-abc",
    });
    expect(calls).toHaveLength(0);
  });

  it("link simbolico che esce dalla radice → blocked anche se il percorso testuale è dentro", async () => {
    await mkdir(path.join(base, "radice-evil"), { recursive: true });
    await symlink(path.join(base, "radice-evil"), path.join(root, "link"));
    const calls: SpawnCall[] = [];
    const report = await runTask(taskPackage({ workspace: "link" }), ctx("esito", calls));
    expect(report).toMatchObject({ status: "blocked", outcome: "spazio di lavoro non valido" });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(base, "radice-evil", "casello-compito.md"))).toBe(false);
  });

  it("scarica e verifica gli allegati in casello-allegati/", async () => {
    const data = Buffer.from("contenuto dell'allegato");
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.end(data);
    });
    let seen = "";
    const inner = fakeSpawn("esito");
    const c = ctx("esito", [], {
      spawn: (cmd, args, opts) => {
        seen = readFileSync(path.join(String(opts.cwd), "casello-allegati", "specifica.txt"), "utf8");
        return inner(cmd, args, opts);
      },
    });
    const pkg = taskPackage({
      attachments: [
        { id: 9, name: "specifica.txt", contentType: "text/plain", sizeBytes: data.length, sha256: sha(data) },
      ],
    });
    const report = await runTask(pkg, c);
    expect(report.status).toBe("done");
    expect(seen).toBe("contenuto dell'allegato");
    expect(casello.calls("GET", "/api/node/tasks/42/attachments/9")[0].headers["x-lease-token"]).toBe("lease-abc");
  });

  it("allegato con sha256 sbagliato → failed, niente file scritti, claude non lanciato", async () => {
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.end("alterato");
    });
    const calls: SpawnCall[] = [];
    const pkg = taskPackage({
      attachments: [
        { id: 9, name: "specifica.txt", contentType: "text/plain", sizeBytes: 8, sha256: sha("originale") },
      ],
    });
    const report = await runTask(pkg, ctx("esito", calls));
    expect(report).toMatchObject({ status: "failed", outcome: "allegato non valido" });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(ws, "casello-allegati", "specifica.txt"))).toBe(false);
    expect(existsSync(path.join(ws, "casello-compito.md"))).toBe(false);
  });

  it.each(["../fuori.txt", "sotto/file.txt", "..", ""])("allegato con nome %j → failed", async (name) => {
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.end("x");
    });
    const calls: SpawnCall[] = [];
    const pkg = taskPackage({
      attachments: [{ id: 9, name, contentType: "text/plain", sizeBytes: 1, sha256: sha("x") }],
    });
    const report = await runTask(pkg, ctx("esito", calls));
    expect(report).toMatchObject({ status: "failed", outcome: "allegato non valido" });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(root, "fuori.txt"))).toBe(false);
  });

  it("cartella casello-allegati che è un link fuori dallo spazio di lavoro → failed, nulla scritto fuori", async () => {
    const data = Buffer.from("x");
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.end(data);
    });
    await mkdir(path.join(base, "altrove"), { recursive: true });
    await symlink(path.join(base, "altrove"), path.join(ws, "casello-allegati"));
    const calls: SpawnCall[] = [];
    const pkg = taskPackage({
      attachments: [{ id: 9, name: "a.txt", contentType: "text/plain", sizeBytes: 1, sha256: sha(data) }],
    });
    const report = await runTask(pkg, ctx("esito", calls));
    expect(report).toMatchObject({ status: "failed", outcome: "allegato non valido" });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(base, "altrove", "a.txt"))).toBe(false);
  });

  it("oltre il tempo massimo → failed «tempo massimo superato»", async () => {
    const c = ctx("sleep");
    c.config = { ...c.config, taskTimeoutMinutes: 0.005 };
    const report = await runTask(taskPackage(), c);
    expect(report).toMatchObject({ status: "failed", outcome: "tempo massimo superato" });
    expect(report.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("un processo che ignora SIGTERM viene chiuso con SIGKILL", async () => {
    const c = ctx("stubborn", [], { killGraceMs: 100 });
    c.config = { ...c.config, taskTimeoutMinutes: 0.005 };
    const started = Date.now();
    const report = await runTask(taskPackage(), c);
    expect(report.outcome).toBe("tempo massimo superato");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("invia i ping durante un compito lungo e segnala la lease rinnovata", async () => {
    process.env.FAKE_CLAUDE_DELAY_MS = "700";
    const renewed: Date[] = [];
    try {
      const report = await runTask(
        taskPackage(),
        ctx("slow", [], { pingIntervalMs: 150, onLeaseRenewed: (d) => renewed.push(d) }),
      );
      expect(report.status).toBe("done");
    } finally {
      delete process.env.FAKE_CLAUDE_DELAY_MS;
    }
    const pings = casello.calls("POST", "/api/node/tasks/42/ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(pings[0].body).toEqual({ leaseToken: "lease-abc" });
    // un ping partito a ridosso della fine può non essere più notificato
    expect(renewed.length).toBeGreaterThanOrEqual(1);
    expect(renewed.length).toBeLessThanOrEqual(pings.length);
  });

  it("claude non avviabile → failed", async () => {
    const report = await runTask(
      taskPackage(),
      ctx("esito", [], {
        spawn: (_cmd, args, opts) => spawn("/percorso/inesistente/claude", args, opts),
      }),
    );
    expect(report.status).toBe("failed");
  });
});

describe("runTask: esiti", () => {
  it("casello-esito.json non valido → esito dal JSON della CLI", async () => {
    const report = await runTask(taskPackage(), ctx("badesito"));
    expect(report).toMatchObject({ status: "done", outcome: "risultato della CLI", costUsd: 0.25 });
  });

  it("casello-esito.json non valido e nessun JSON della CLI → failed", async () => {
    const report = await runTask(taskPackage(), ctx("badesito-nocli"));
    expect(report.status).toBe("failed");
    expect(report.outcome).toMatch(/^Claude Code terminato senza esito/);
  });

  it("JSON della CLI senza costo né token → report senza costi", async () => {
    const report = await runTask(taskPackage(), ctx("nocost"));
    expect(report).toMatchObject({ status: "done", outcome: "fatto senza costi" });
    expect(report.costUsd).toBeUndefined();
    expect(report.promptTokens).toBeUndefined();
    expect(report.completionTokens).toBeUndefined();
  });

  it("due allegati con lo stesso nome → failed «allegato non valido»", async () => {
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.end("x");
    });
    const calls: SpawnCall[] = [];
    const a = { name: "doppio.txt", contentType: "text/plain", sizeBytes: 1, sha256: sha("x") };
    const report = await runTask(
      taskPackage({
        attachments: [
          { id: 1, ...a },
          { id: 2, ...a },
        ],
      }),
      ctx("esito", calls),
    );
    expect(report).toMatchObject({ status: "failed", outcome: "allegato non valido" });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(ws, "casello-allegati", "doppio.txt"))).toBe(false);
  });

  it("allegati con nomi uguali a meno delle maiuscole → failed «allegato non valido» (APFS)", async () => {
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.end("x");
    });
    const calls: SpawnCall[] = [];
    const a = { contentType: "text/plain", sizeBytes: 1, sha256: sha("x") };
    const report = await runTask(
      taskPackage({
        attachments: [
          { id: 1, name: "Nota.txt", ...a },
          { id: 2, name: "nota.TXT", ...a },
        ],
      }),
      ctx("esito", calls),
    );
    expect(report).toMatchObject({ status: "failed", outcome: "allegato non valido" });
    expect(calls).toHaveLength(0);
  });
});

describe("runTask: processi", () => {
  it("un nipote che ignora SIGTERM e sopravvive a claude muore comunque allo scadere del SIGKILL", async () => {
    const c = ctx("grandchild", [], { killGraceMs: 1_500, drainMs: 200 });
    c.config = { ...c.config, taskTimeoutMinutes: 0.005 };
    const report = await runTask(taskPackage(), c);
    expect(report.outcome).toBe("tempo massimo superato");
    const pid = Number(readFileSync(path.join(ws, "nipote.pid"), "utf8"));
    // Il compito è chiuso (drain 200 ms) ma il SIGKILL non è ancora scattato: il nipote è vivo
    expect(() => process.kill(pid, 0)).not.toThrow();
    await waitDead(pid);
  });

  it("al tempo massimo termina tutto il gruppo, anche un nipote che tiene aperto stdout", async () => {
    const c = ctx("grandchild", [], { killGraceMs: 100, drainMs: 300 });
    c.config = { ...c.config, taskTimeoutMinutes: 0.005 };
    const started = Date.now();
    const report = await runTask(taskPackage(), c);
    expect(report).toMatchObject({ status: "failed", outcome: "tempo massimo superato" });
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(path.join(ws, "nipote.pid"), "utf8"));
    await waitDead(pid);
  });

  it("un errore dopo l'avvio non chiude il compito come «non avviabile»", async () => {
    const inner = fakeSpawn("slow");
    const c = ctx("slow", [], {
      spawn: (cmd, args, opts) => {
        const child = inner(cmd, args, opts);
        child.once("spawn", () => setImmediate(() => child.emit("error", new Error("kill non riuscito"))));
        return child;
      },
    });
    const report = await runTask(taskPackage(), c);
    expect(report).toMatchObject({ status: "done", outcome: "fatto dal file" });
  });

  it("ping con 409 → compito interrotto (gruppo terminato) e report «lease non valida o scaduta»", async () => {
    casello.on("POST", "/api/node/tasks/:id/ping", (_req, res) =>
      json(res, 409, { error: "lease non valida o scaduta" }),
    );
    let child: ChildProcess | undefined;
    const inner = fakeSpawn("sleep");
    const c = ctx("sleep", [], {
      pingIntervalMs: 50,
      spawn: (cmd, args, opts) => (child = inner(cmd, args, opts)),
    });
    const started = Date.now();
    const report = await runTask(taskPackage(), c);
    expect(report).toMatchObject({ status: "failed", outcome: "lease non valida o scaduta" });
    expect(isLeaseLostReport(report)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  });

  it("lo stop del nodo interrompe il compito", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const report = await runTask(taskPackage(), ctx("sleep", [], { signal: stop.signal }));
    expect(report).toMatchObject({ status: "failed", outcome: "esecuzione interrotta: nodo fermato" });
  });

  it("ping anche durante il download degli allegati", async () => {
    const data = Buffer.from("lento");
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      setTimeout(() => {
        res.statusCode = 200;
        res.end(data);
      }, 400);
    });
    const calls: SpawnCall[] = [];
    let spawnedAt = 0;
    const inner = fakeSpawn("esito", calls);
    const pkg = taskPackage({
      attachments: [{ id: 9, name: "a.txt", contentType: "text/plain", sizeBytes: data.length, sha256: sha(data) }],
    });
    await runTask(
      pkg,
      ctx("esito", calls, {
        pingIntervalMs: 100,
        spawn: (cmd, args, opts) => {
          spawnedAt = Date.now();
          return inner(cmd, args, opts);
        },
      }),
    );
    const before = casello.calls("POST", "/api/node/tasks/42/ping").filter((r) => r.at < spawnedAt);
    expect(before.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runTask: stesso spazio di lavoro", () => {
  function traced(mode: string, delayMs: string, spans: Array<{ start: number; end: number }>) {
    const inner = fakeSpawn(mode, [], { FAKE_CLAUDE_DELAY_MS: delayMs });
    return (cmd: string, args: readonly string[], opts: SpawnOptions) => {
      const span = { start: Date.now(), end: 0 };
      spans.push(span);
      const child = inner(cmd, args, opts);
      child.on("exit", () => {
        span.end = Date.now();
      });
      return child;
    };
  }

  it("due compiti nello stesso spazio girano uno alla volta; chi aspetta rinnova la lease", async () => {
    const queue = new WorkspaceQueue();
    const spans: Array<{ start: number; end: number }> = [];
    const first = ctx("slow", [], { workspaceQueue: queue, spawn: traced("slow", "500", spans) });
    // Il tempo massimo del secondo conta da quando parte davvero (600 ms < 500 di attesa + 300 di lavoro)
    const second = ctx("slow", [], { workspaceQueue: queue, pingIntervalMs: 100, spawn: traced("slow", "300", spans) });
    second.config = { ...second.config, taskTimeoutMinutes: 0.01 };
    const [r1, r2] = await Promise.all([
      runTask(taskPackage({ taskId: 42 }), first),
      runTask(taskPackage({ taskId: 43, leaseToken: "lease-due" }), second),
    ]);
    expect(r1).toMatchObject({ status: "done", outcome: "fatto dal file" });
    expect(r2).toMatchObject({ status: "done", outcome: "fatto dal file" });
    expect(spans).toHaveLength(2);
    expect(spans[1].start).toBeGreaterThanOrEqual(spans[0].end);
    const waitingPings = casello.calls("POST", "/api/node/tasks/43/ping").filter((r) => r.at < spans[1].start);
    expect(waitingPings.length).toBeGreaterThanOrEqual(1);
    expect(waitingPings[0].body).toEqual({ leaseToken: "lease-due" });
  });

  it("due compiti in spazi diversi girano in parallelo", async () => {
    await mkdir(path.join(root, "altro"), { recursive: true });
    const queue = new WorkspaceQueue();
    const spans: Array<{ start: number; end: number }> = [];
    const [r1, r2] = await Promise.all([
      runTask(
        taskPackage({ taskId: 42 }),
        ctx("slow", [], { workspaceQueue: queue, spawn: traced("slow", "400", spans) }),
      ),
      runTask(
        taskPackage({ taskId: 43, workspace: "altro" }),
        ctx("slow", [], { workspaceQueue: queue, spawn: traced("slow", "400", spans) }),
      ),
    ]);
    expect([r1.status, r2.status]).toEqual(["done", "done"]);
    expect(spans).toHaveLength(2);
    const [a, b] = spans;
    expect(Math.max(a.start, b.start)).toBeLessThan(Math.min(a.end, b.end));
  });
});

async function waitDead(pid: number): Promise<void> {
  const until = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > until) {
      process.kill(pid, "SIGKILL");
      throw new Error(`il processo ${pid} è ancora vivo`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function realCwd(call: SpawnCall): Promise<string> {
  return realpath(String(call.options.cwd));
}
