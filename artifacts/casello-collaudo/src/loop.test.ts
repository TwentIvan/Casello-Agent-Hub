import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserDriver } from "./browser";
import { CollaudoClient } from "./client";
import { runCollaudo, type LoopDeps } from "./loop";
import type { TestRecipe } from "./recipe-run";

type Call = { path: string; auth: string | undefined; headers: IncomingMessage["headers"]; body: Buffer };
type Reply = { status: number; json?: unknown };
type Handler = (call: Call) => Reply;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9]);
const RECIPE: TestRecipe = {
  install: [],
  build: [],
  services: [{ name: "web", command: "true", port: 4321, readyPath: "/" }],
  postgres: false,
  schema: [],
  env: {},
  startUrl: "/",
  login: null,
};

let server: Server;
let base: string;
let calls: Call[];
let handler: Handler;
let workDir: string;

beforeEach(async () => {
  calls = [];
  workDir = await mkdtemp(path.join(tmpdir(), "collaudo-loop-"));
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const call: Call = { path: req.url ?? "", auth: req.headers.authorization, headers: req.headers, body: Buffer.concat(chunks) };
      calls.push(call);
      const reply = handler(call);
      res.statusCode = reply.status;
      if (reply.json !== undefined) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply.json));
      } else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(workDir, { recursive: true, force: true });
});

function fakeBrowser(log: string[]): BrowserDriver {
  return {
    open: async (url) => (log.push(`open ${url}`), `aperta ${url}`),
    click: async (sel) => `clic su ${sel}`,
    fill: async (sel) => `compilato ${sel}`,
    press: async (key) => `premuto ${key}`,
    snapshot: async () => "albero",
    screenshot: async () => (log.push("screenshot"), PNG),
    wait: async (ms) => `atteso ${ms} ms`,
    waitFor: async () => "trovato",
    close: async () => (log.push("close"), { video: WEBM }),
  };
}

function deps(over: Partial<LoopDeps>, browserLog: string[] = []): LoopDeps {
  return {
    client: new CollaudoClient(base),
    workDir,
    clone: async (_repo, _sha, _token, dir) => {
      await mkdir(dir, { recursive: true });
    },
    browser: async () => fakeBrowser(browserLog),
    openTunnel: async (port) => ({ url: `https://prova-${port}.trycloudflare.com`, close: () => browserLog.push("tunnel chiuso") }),
    tunnelMs: 50,
    pingMs: 10_000,
    log: () => {},
    ...over,
  };
}

const json = (c: Call) => JSON.parse(c.body.toString("utf8") || "{}");
const paths = () => calls.map((c) => c.path);

describe("runCollaudo", () => {
  it("claim → due comandi → risultati in ordine → screenshot → video → tunnel → report done", async () => {
    const commands = [
      { id: 1, kind: "shell", args: { command: "echo uno" } },
      { id: 2, kind: "browser", args: { action: "screenshot" } },
    ];
    handler = (c) => {
      if (c.path === "/api/collaudo/claim") return { status: 200, json: { token: "ctk_prova", repo: "o/r", sha: "a".repeat(40), repoToken: "ghs_x", recipe: RECIPE, mode: "full" } };
      if (c.path === "/api/collaudo/next") {
        const cmd = commands.shift();
        return cmd ? { status: 200, json: cmd } : { status: 410, json: { error: "collaudo consegnato" } };
      }
      if (c.path === "/api/collaudo/files") return { status: 201, json: { id: c.headers["x-file-kind"] === "video" ? 99 : 77 } };
      return { status: 204 };
    };
    const log: string[] = [];
    const outcome = await runCollaudo(7, "codice-monouso-prova-1234", deps({}, log));
    expect(outcome).toBe("done");

    const claim = calls[0]!;
    expect(json(claim)).toEqual({ testId: 7, code: "codice-monouso-prova-1234" });
    expect(calls.slice(1).every((c) => c.auth === "Bearer ctk_prova")).toBe(true);

    const results = calls.filter((c) => c.path.startsWith("/api/collaudo/results/"));
    expect(results.map((c) => c.path)).toEqual(["/api/collaudo/results/1", "/api/collaudo/results/2"]);
    expect(json(results[0]!)).toEqual({ ok: true, output: "uno\n" });
    expect(json(results[1]!)).toEqual({ ok: true, output: "77" });

    const files = calls.filter((c) => c.path === "/api/collaudo/files");
    expect(files.map((c) => c.headers["x-file-kind"])).toEqual(["screenshot", "video"]);
    expect(files[0]!.body.equals(PNG)).toBe(true);
    expect(paths().indexOf("/api/collaudo/files")).toBeLessThan(paths().indexOf("/api/collaudo/results/2"));

    const tunnel = calls.find((c) => c.path === "/api/collaudo/tunnel")!;
    expect(json(tunnel).url).toBe("https://prova-4321.trycloudflare.com");
    expect(Date.parse(json(tunnel).until)).toBeGreaterThan(Date.now() - 5_000);

    expect(paths().at(-1)).toBe("/api/collaudo/report");
    expect(json(calls.at(-1)!)).toEqual({ status: "done" });
    expect(log).toEqual(["screenshot", "close", "tunnel chiuso"]);
  });

  it("un 401 sulla next → fine senza report", async () => {
    handler = (c) => {
      if (c.path === "/api/collaudo/claim") return { status: 200, json: { token: "ctk_prova", repo: "o/r", sha: "a".repeat(40), repoToken: "ghs_x", recipe: null, mode: "full" } };
      if (c.path === "/api/collaudo/next") return { status: 401, json: { error: "token non valido" } };
      return { status: 204 };
    };
    const outcome = await runCollaudo(7, "codice-monouso-prova-1234", deps({}));
    expect(outcome).toBe("closed");
    expect(paths()).not.toContain("/api/collaudo/report");
    expect(paths()).not.toContain("/api/collaudo/tunnel");
  });

  it("relight: ricetta, tunnel e report senza chiedere comandi", async () => {
    handler = (c) => {
      if (c.path === "/api/collaudo/claim") return { status: 200, json: { token: "ctk_prova", repo: "o/r", sha: "a".repeat(40), repoToken: "ghs_x", recipe: RECIPE, mode: "relight" } };
      return { status: 204 };
    };
    const ran: string[] = [];
    const outcome = await runCollaudo(
      7,
      "codice-monouso-prova-1234",
      deps({ runRecipe: async (r) => (ran.push(r.services[0]!.name), { ok: true, output: "", port: 5555 }) }),
    );
    expect(outcome).toBe("done");
    expect(ran).toEqual(["web"]);
    expect(paths()).not.toContain("/api/collaudo/next");
    expect(json(calls.find((c) => c.path === "/api/collaudo/tunnel")!).url).toBe("https://prova-5555.trycloudflare.com");
    expect(json(calls.at(-1)!)).toEqual({ status: "done" });
  });

  it("relight con la ricetta che non parte → report failed, nessun tunnel", async () => {
    handler = (c) => {
      if (c.path === "/api/collaudo/claim") return { status: 200, json: { token: "ctk_prova", repo: "o/r", sha: "a".repeat(40), repoToken: "ghs_x", recipe: RECIPE, mode: "relight" } };
      return { status: 204 };
    };
    const outcome = await runCollaudo(7, "codice-monouso-prova-1234", deps({ runRecipe: async () => ({ ok: false, output: "no", port: 4321 }) }));
    expect(outcome).toBe("failed");
    expect(paths()).not.toContain("/api/collaudo/tunnel");
    expect(json(calls.at(-1)!)).toEqual({ status: "failed" });
  });

  it("codice rifiutato al claim → chiuso senza report", async () => {
    handler = () => ({ status: 401, json: { error: "codice non valido o scaduto" } });
    const outcome = await runCollaudo(7, "codice-monouso-prova-1234", deps({}));
    expect(outcome).toBe("closed");
    expect(paths()).toEqual(["/api/collaudo/claim"]);
  });
});
