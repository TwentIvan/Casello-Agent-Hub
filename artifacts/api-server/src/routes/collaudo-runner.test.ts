import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, releaseTestFilesTable, releaseTestsTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../test/fake-github";
import { seedReleaseTest } from "../../test/collaudo-fixture";
import { clearInstallationTokenCache } from "../lib/github/app";
import { enqueueCommand } from "../lib/collaudo/commands";
import { setOnTestClaimed } from "../lib/collaudo/protocol";
import { issueCode } from "../lib/collaudo/tokens";

// Protocollo del runner di collaudo sull'app completa (porta 0) con il finto GitHub.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE"];
const saved: Record<string, string | undefined> = {};
const RECIPE = {
  install: ["npm ci"],
  build: [],
  services: [{ name: "web", command: "npm start", port: 3000, readyPath: "/" }],
  postgres: false,
  schema: [],
  env: {},
  startUrl: "/",
  login: null,
};
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let ipCounter = 0;
let base: string;
let server: http.Server;
let gh: FakeGithub;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(path: string, opts: { token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string; json: any }> {
  // IP diverso a ogni chiamata (trust proxy = 1 come nei test dei webhook): il limite del claim è per IP e in memoria
  const headers: Record<string, string> = { "x-forwarded-for": `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, ...(opts.headers ?? {}) };
  if (opts.raw === undefined) headers["content-type"] = "application/json";
  else headers["content-type"] = "application/octet-stream";
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api/collaudo${path}`, {
    method: "POST",
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
  return { status: res.status, text, json: isJson && text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  const { default: app } = await import("../app");
  app.set("trust proxy", 1);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await gh.close();
  setOnTestClaimed(() => {});
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  clearInstallationTokenCache();
  gh.addInstallation({ id: 7, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: "ivan/mister", defaultBranch: "main", private: true },
  ]);
  setOnTestClaimed(() => {});
});

/** Collaudo `dispatching` con codice emesso e claim fatto: restituisce il token del runner. */
async function running(): Promise<{ testId: number; token: string }> {
  const { testId } = await seedReleaseTest({ recipe: RECIPE });
  const code = await issueCode(testId);
  const res = await call("/claim", { body: { testId, code } });
  expect(res.status, res.text).toBe(200);
  return { testId, token: res.json.token as string };
}

describe("claim", () => {
  it("codice giusto: pacchetto con token, repository, sha, token del repository ristretto e ricetta", async () => {
    const calls: Array<[number, string]> = [];
    setOnTestClaimed((id, mode) => void calls.push([id, mode]));
    const { testId } = await seedReleaseTest({ recipe: RECIPE });
    const code = await issueCode(testId);
    const res = await call("/claim", { body: { testId, code } });
    expect(res.status, res.text).toBe(200);
    expect(res.json.token).toMatch(/^ctk_/);
    expect(res.json).toMatchObject({ repo: "ivan/mister", sha: "def5678", mode: "full", recipe: RECIPE });
    const issued = gh.issuedTokens.get(res.json.repoToken);
    expect(issued?.permissions).toEqual({ contents: "read" });
    expect(issued?.repositories).toEqual(["ivan/mister"]);
    const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId));
    expect(row!.status).toBe("running");
    expect(row!.tokenHash).not.toBeNull();
    expect(row!.tokenHash).not.toContain("ctk_");
    expect(row!.codeHash).toBeNull();
    expect(row!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 79 * 60_000);
    expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(calls).toEqual([[testId, "full"]]);
  });

  it("secondo claim con lo stesso codice → 401", async () => {
    const { testId } = await seedReleaseTest();
    const code = await issueCode(testId);
    expect((await call("/claim", { body: { testId, code } })).status).toBe(200);
    expect((await call("/claim", { body: { testId, code } })).status).toBe(401);
  });

  it("codice sbagliato → 401; codice scaduto → 401", async () => {
    const { testId } = await seedReleaseTest();
    const code = await issueCode(testId);
    expect((await call("/claim", { body: { testId, code: "x".repeat(43) } })).status).toBe(401);
    await db.update(releaseTestsTable).set({ codeExpiresAt: new Date(Date.now() - 1_000) }).where(eq(releaseTestsTable.id, testId));
    expect((await call("/claim", { body: { testId, code } })).status).toBe(401);
  });

  it("una callback asincrona che rifiuta non dà unhandled rejection e il claim riesce", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      setOnTestClaimed(async () => {
        throw new Error("avvio fallito");
      });
      const { testId } = await seedReleaseTest();
      const code = await issueCode(testId);
      expect((await call("/claim", { body: { testId, code } })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ricetta non valida → null nel pacchetto", async () => {
    const { testId } = await seedReleaseTest({ recipe: { install: "no" } });
    const code = await issueCode(testId);
    const res = await call("/claim", { body: { testId, code } });
    expect(res.status).toBe(200);
    expect(res.json.recipe).toBeNull();
  });

  it("GitHub senza accesso → 502 con messaggio fisso e codice non consumato", async () => {
    const { testId } = await seedReleaseTest({ installationId: 999 });
    const code = await issueCode(testId);
    const res = await call("/claim", { body: { testId, code } });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("accesso al repository non disponibile");
    const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId));
    expect(row!.status).toBe("dispatching");
  });

  it("limite di 10 richieste al minuto per IP", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("/claim", { body: { testId: 1, code: "x".repeat(43) }, headers: { "x-forwarded-for": "10.9.9.9" } })).status;
    expect(last).toBe(429);
  });
});

describe("autenticazione", () => {
  it("next senza token o con token sbagliato → 401", async () => {
    expect((await call("/next")).status).toBe(401);
    expect((await call("/next", { token: "ctk_sbagliato" })).status).toBe(401);
    expect((await call("/next", { token: "cas_qualcosa" })).status).toBe(401);
  });

  it("token scaduto → 401", async () => {
    const { testId, token } = await running();
    await db.update(releaseTestsTable).set({ tokenExpiresAt: new Date(Date.now() - 1_000) }).where(eq(releaseTestsTable.id, testId));
    expect((await call("/ping", { token })).status).toBe(401);
  });
});

describe("comandi e risultati", () => {
  it("next consegna il comando, results lo chiude; 204 senza comandi", async () => {
    const { testId, token } = await running();
    const id = await enqueueCommand(testId, "shell", { command: "ls" });
    const next = await call("/next", { token });
    expect(next.status).toBe(200);
    expect(next.json).toEqual({ id, kind: "shell", args: { command: "ls" } });
    expect((await call(`/results/${id}`, { token, body: { ok: true, output: "a.txt" } })).status).toBe(204);
    expect((await call(`/results/${id}`, { token, body: { ok: true, output: "a.txt" } })).status).toBe(404);
  });

  it("next → 410 quando il collaudo ha già l'esito", async () => {
    const { testId, token } = await running();
    await db.update(releaseTestsTable).set({ outcome: "ok" }).where(eq(releaseTestsTable.id, testId));
    const res = await call("/next", { token });
    expect(res.status).toBe(410);
    expect(res.json).toEqual({ error: "collaudo consegnato", liveLink: true });
  });

  it("next → 410 senza link dal vivo con un errore registrato o con l'App non avviabile", async () => {
    const { testId, token } = await running();
    await db.update(releaseTestsTable).set({ error: "collaudo interrotto" }).where(eq(releaseTestsTable.id, testId));
    const failed = await call("/next", { token });
    expect(failed.status).toBe(410);
    expect(failed.json.liveLink).toBe(false);
    await db.update(releaseTestsTable).set({ error: null, outcome: "not_startable" }).where(eq(releaseTestsTable.id, testId));
    expect((await call("/next", { token })).json).toEqual({ error: "collaudo consegnato", liveLink: false });
    await db.update(releaseTestsTable).set({ outcome: "problems" }).where(eq(releaseTestsTable.id, testId));
    expect((await call("/next", { token })).json.liveLink).toBe(true);
  });

  it("ping rinnova la lease", async () => {
    const { testId, token } = await running();
    await db.update(releaseTestsTable).set({ leaseExpiresAt: new Date(Date.now() + 1_000) }).where(eq(releaseTestsTable.id, testId));
    expect((await call("/ping", { token })).status).toBe(200);
    const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId));
    expect(row!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });
});

describe("tunnel", () => {
  it("indirizzo fuori da trycloudflare.com → 400", async () => {
    const { token } = await running();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const url of ["https://evil.example", "http://a.trycloudflare.com", "https://trycloudflare.com.evil.example", "https://a.trycloudflare.com@evil.example", "https://api.trycloudflare.com"]) {
      expect((await call("/tunnel", { token, body: { url, until } })).status, url).toBe(400);
    }
  });

  it("scadenza oltre 31 minuti o passata → 400; valido → 204 e salvato", async () => {
    const { testId, token } = await running();
    const url = "https://abc-def.trycloudflare.com";
    expect((await call("/tunnel", { token, body: { url, until: new Date(Date.now() + 40 * 60_000).toISOString() } })).status).toBe(400);
    expect((await call("/tunnel", { token, body: { url, until: new Date(Date.now() - 1_000).toISOString() } })).status).toBe(400);
    expect((await call("/tunnel", { token, body: { url, until: new Date(Date.now() + 30 * 60_000).toISOString() } })).status).toBe(204);
    const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId));
    expect(row!.tunnelUrl).toBe(url);
  });
});

describe("file", () => {
  const send = (token: string, kind: string, bytes: Buffer, name = "prova.png") =>
    call("/files", { token, raw: bytes, headers: { "x-file-kind": kind, "x-file-name": name } });

  it("screenshot non PNG → 400; video non WebM → 400; tipo sconosciuto → 400", async () => {
    const { token } = await running();
    expect((await send(token, "screenshot", Buffer.from("non è un png"))).status).toBe(400);
    expect((await send(token, "video", PNG, "v.webm")).status).toBe(400);
    expect((await send(token, "altro", PNG)).status).toBe(400);
    expect((await send(token, "screenshot", PNG, "../x.png")).status).toBe(400);
  });

  it("PNG e WebM validi → 201 e righe salvate con il tipo dai primi byte", async () => {
    const { testId, token } = await running();
    expect((await send(token, "screenshot", PNG)).status).toBe(201);
    expect((await send(token, "video", WEBM, "collaudo.webm")).status).toBe(201);
    const files = await db.select().from(releaseTestFilesTable).where(eq(releaseTestFilesTable.testId, testId));
    expect(files.map((f) => [f.kind, f.contentType]).sort()).toEqual([["screenshot", "image/png"], ["video", "video/webm"]]);
  });

  it("PNG oltre 2 MB → 413; un secondo video → 413", async () => {
    const { token } = await running();
    expect((await send(token, "screenshot", Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]))).status).toBe(413);
    expect((await send(token, "video", WEBM, "a.webm")).status).toBe(201);
    expect((await send(token, "video", WEBM, "b.webm")).status).toBe(413);
  });

  it("al più 20 screenshot", async () => {
    const { token } = await running();
    for (let i = 0; i < 20; i++) expect((await send(token, "screenshot", PNG, `s${i}.png`)).status).toBe(201);
    expect((await send(token, "screenshot", PNG, "s20.png")).status).toBe(413);
  });
});

describe("report", () => {
  it("revoca il token: next dopo → 401; chiude tunnel e comandi aperti", async () => {
    const { testId, token } = await running();
    const id = await enqueueCommand(testId, "shell", {});
    await call("/tunnel", { token, body: { url: "https://abc.trycloudflare.com", until: new Date(Date.now() + 10 * 60_000).toISOString() } });
    expect((await call("/report", { token, body: { status: "done" } })).status).toBe(204);
    expect((await call("/next", { token })).status).toBe(401);
    const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId));
    expect(row!.tokenHash).toBeNull();
    expect(row!.tunnelUrl).toBeNull();
    // Nessuna consegna dell'agente: il collaudo chiude «non consegnato»
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("collaudo non consegnato");
    const { releaseTestCommandsTable } = await import("@workspace/db");
    const [cmd] = await db.select().from(releaseTestCommandsTable).where(eq(releaseTestCommandsTable.id, id));
    expect(cmd!.status).toBe("expired");
  });

  it("«Riaccendi»: done → done; failed → failed «ricetta di avvio non riuscita»", async () => {
    const ok = await running();
    await db.update(releaseTestsTable).set({ mode: "relight" }).where(eq(releaseTestsTable.id, ok.testId));
    expect((await call("/report", { token: ok.token, body: { status: "done" } })).status).toBe(204);
    const [done] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, ok.testId));
    expect(done).toMatchObject({ status: "done", error: null, tokenHash: null });

    const ko = await running();
    await db.update(releaseTestsTable).set({ mode: "relight" }).where(eq(releaseTestsTable.id, ko.testId));
    expect((await call("/report", { token: ko.token, body: { status: "failed" } })).status).toBe(204);
    const [failed] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, ko.testId));
    expect(failed).toMatchObject({ status: "failed", error: "ricetta di avvio non riuscita", tokenHash: null, leaseExpiresAt: null });
  });

  it("esito consegnato e report failed → done, errore dell'agente conservato senza esito", async () => {
    const a = await running();
    await db.update(releaseTestsTable).set({ outcome: "ok" }).where(eq(releaseTestsTable.id, a.testId));
    await call("/report", { token: a.token, body: { status: "failed" } });
    expect((await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, a.testId)))[0]).toMatchObject({ status: "done", error: null });
    const b = await running();
    await db.update(releaseTestsTable).set({ error: "errore interno nel collaudo" }).where(eq(releaseTestsTable.id, b.testId));
    await call("/report", { token: b.token, body: { status: "done" } });
    expect((await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, b.testId)))[0]).toMatchObject({ status: "failed", error: "errore interno nel collaudo" });
  });

  it("failed senza consegna dell'agente → collaudo failed con messaggio fisso", async () => {
    const { testId, token } = await running();
    expect((await call("/report", { token, body: { status: "failed", error: "testo del runner" } })).status).toBe(204);
    const [row] = await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, testId));
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("collaudo interrotto");
  });
});
