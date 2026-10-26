import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, catalogRunsTable, modelCatalogTable, usersTable } from "@workspace/db";
import { fakeSourcesFetch } from "../../test/fake-sources";
import { encryptSecret } from "../lib/secrets";

// API del catalogo su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true). Il secondo
// utente si inserisce a mano. Le fonti sono finte; ogni aggiornamento avviato si attende prima di
// chiudere il test, così nessuna riga `running` resta per gli altri file.

const realFetch = globalThis.fetch;
const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let fullBase: string;
let server: http.Server;
let fullServer: http.Server;
let currentFetch: typeof fetch;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}
function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, root = base): Promise<{ status: number; text: string; json: any }> {
  const res = await realFetch(`${root}/api${path}`, { method });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function waitIdle(): Promise<void> {
  for (;;) {
    const rows = await db.select().from(catalogRunsTable);
    if (!rows.some((r) => r.status === "running")) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function devUserId(): Promise<number> {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);

  const { requireAuth } = await import("../lib/auth");
  const { createCatalogRouter } = await import("./catalog");
  const { errorHandler } = await import("../middlewares/error-handler");
  const noLimit: RequestHandler = (_req, _res, next) => next();
  const mini = express();
  mini.use(express.json());
  // Il fetch delle fonti si legge a ogni chiamata, così ogni test può cambiarlo
  const fetchImpl = ((...args: Parameters<typeof fetch>) => currentFetch(...args)) as typeof fetch;
  mini.use("/api", requireAuth, createCatalogRouter({ refreshRateLimit: noLimit, fetchImpl }));
  mini.use("/api", errorHandler);
  server = http.createServer(mini);
  base = `http://127.0.0.1:${await listen(server)}`;

  const { default: app } = await import("../app");
  fullServer = http.createServer(app);
  fullBase = `http://127.0.0.1:${await listen(fullServer)}`;
});

afterAll(async () => {
  await waitIdle();
  await close(server);
  await close(fullServer);
  await pool.query("TRUNCATE users, ai_accounts, catalog_runs, model_catalog RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  currentFetch = fakeSourcesFetch();
  await waitIdle();
  await pool.query("TRUNCATE users, ai_accounts, catalog_runs, model_catalog RESTART IDENTITY CASCADE");
});

/** Fonti che rispondono solo dopo `release()`: tiene l'aggiornamento in corso quanto serve al test. */
function gatedSources(): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inner = fakeSourcesFetch();
  currentFetch = (async (...args: Parameters<typeof fetch>) => {
    await gate;
    return inner(...args);
  }) as typeof fetch;
  return release;
}

describe("aggiornamento", () => {
  it("risponde 202 running; a fine esecuzione lo stato è completed", async () => {
    const release = gatedSources();
    const res = await api("POST", "/catalog/refresh");
    expect(res.status, res.text).toBe(202);
    expect(res.json).toMatchObject({ trigger: "manual", status: "running", finishedAt: null, summary: null });
    expect((await api("GET", "/catalog/status")).json).toMatchObject({ running: true, latest: { id: res.json.id, status: "running" } });

    release();
    await waitIdle();
    const status = await api("GET", "/catalog/status");
    expect(status.json.running).toBe(false);
    expect(status.json.latest).toMatchObject({ id: res.json.id, status: "completed", error: null });
    expect(status.json.latest.finishedAt).toEqual(expect.any(String));
    expect(status.json.latest.summary).toMatchObject({ firstRun: true, accounts: [] });

    // Seconda esecuzione: ora le novità sono calcolate (nulla di cambiato con le stesse fonti)
    await api("POST", "/catalog/refresh");
    await waitIdle();
    const second = await api("GET", "/catalog/status");
    expect(second.json.latest.summary).toMatchObject({ firstRun: false, added: [] });
  });

  it("un secondo aggiornamento durante il primo risponde 409", async () => {
    const release = gatedSources();

    const first = await api("POST", "/catalog/refresh");
    expect(first.status).toBe(202);
    const second = await api("POST", "/catalog/refresh");
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "aggiornamento già in corso" });
    release();
    await waitIdle();
  });

  it("lo stato senza esecuzioni è vuoto", async () => {
    expect((await api("GET", "/catalog/status")).json).toEqual({ running: false, latest: null });
  });

  it("ha un rate limit di 2 al minuto sull'app completa", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await api("POST", "/catalog/refresh", fullBase)).status);
      await waitIdle();
    }
    expect(codes).toEqual([202, 202, 429]);
  });
});

describe("riepilogo per utente", () => {
  it("mostra solo gli account dell'utente corrente, senza userId", async () => {
    const me = await devUserId().catch(async () => {
      await api("GET", "/catalog/status");
      return devUserId();
    });
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    const [mine, theirs] = await db
      .insert(aiAccountsTable)
      .values([
        { userId: me, name: "Mio", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" },
        { userId: other!.id, name: "Dell'altro", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnc: encryptSecret("sk-y"), status: "ok" },
      ])
      .returning();
    await db.insert(catalogRunsTable).values({
      trigger: "scheduled",
      status: "completed",
      finishedAt: new Date(),
      summary: {
        firstRun: false,
        added: [],
        retired: [],
        deprecating: [],
        priceChanged: [],
        accounts: [
          { accountId: mine!.id, userId: me, accountName: "Mio", missing: ["a"] },
          { accountId: theirs!.id, userId: other!.id, accountName: "Dell'altro", missing: ["b"] },
        ],
      },
    });

    const res = await api("GET", "/catalog/status");
    expect(res.json.latest.summary.accounts).toEqual([{ accountId: mine!.id, accountName: "Mio", missing: ["a"] }]);
    expect(res.text).not.toContain("userId");
    expect(res.text).not.toContain("Dell'altro");
  });
});

describe("elenco dei modelli", () => {
  async function seed() {
    const me = await (async () => {
      await api("GET", "/catalog/status");
      return devUserId();
    })();
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
    const rows = await db
      .insert(modelCatalogTable)
      .values([
        { provider: "gemini", modelId: "gemini-2.5-flash", family: "gemini-flash", version: "2.5", releasedAt: new Date("2025-06-01"), priceInputPerMtok: "0.3", priceOutputPerMtok: "2.5", contextTokens: 1048576, supportsTools: true },
        { provider: "gemini", modelId: "gemini-3.5-flash", family: "gemini-flash", version: "3.5", releasedAt: new Date("2026-05-01"), status: "deprecated", deprecationDate: new Date("2027-01-01") },
        { provider: "deepseek", modelId: "deepseek-chat", family: "deepseek-chat", version: "3", releasedAt: null },
      ])
      .returning();
    const old = rows[0]!;
    const [mine, theirs] = await db
      .insert(aiAccountsTable)
      .values([
        { userId: me, name: "Mio", provider: "gemini", baseUrl: "https://g.example.com", apiKeyEnc: encryptSecret("sk-x"), status: "ok" },
        { userId: other!.id, name: "Altro", provider: "deepseek", baseUrl: "https://d.example.com", apiKeyEnc: encryptSecret("sk-y"), status: "ok" },
      ])
      .returning();
    await db.insert(aiModelsTable).values([
      { accountId: mine!.id, modelId: "gemini-2.5-flash", displayName: "G", catalogId: old.id },
      { accountId: theirs!.id, modelId: "deepseek-chat", displayName: "D", catalogId: rows[2]!.id },
    ]);
  }

  it("filtra per provider, ordina per uscita decrescente e marca solo i modelli dei propri account", async () => {
    await seed();
    const res = await api("GET", "/catalog/models?provider=gemini");
    expect(res.status, res.text).toBe(200);
    expect(res.json.map((m: { modelId: string }) => m.modelId)).toEqual(["gemini-3.5-flash", "gemini-2.5-flash"]);
    expect(res.json[0]).toMatchObject({ provider: "gemini", status: "deprecated", inMyAccounts: false, priceInput: null });
    expect(res.json[1]).toMatchObject({ inMyAccounts: true, priceInput: 0.3, priceOutput: 2.5, contextTokens: 1048576, supportsTools: true });
  });

  it("il modello di un altro utente non è mio; senza provider tornano tutti, ordinati per provider", async () => {
    await seed();
    const res = await api("GET", "/catalog/models");
    expect(res.json.map((m: { modelId: string }) => m.modelId)).toEqual(["deepseek-chat", "gemini-3.5-flash", "gemini-2.5-flash"]);
    expect(res.json[0].inMyAccounts).toBe(false);
  });

  it("un provider sconosciuto è 400", async () => {
    expect((await api("GET", "/catalog/models?provider=nope")).status).toBe(400);
  });

  it("le route sono dietro il login (montate nell'app)", async () => {
    // Senza AUTH_DISABLED l'app risponderebbe 401: qui basta che la route esista
    expect((await api("GET", "/catalog/models", fullBase)).status).toBe(200);
  });
});
