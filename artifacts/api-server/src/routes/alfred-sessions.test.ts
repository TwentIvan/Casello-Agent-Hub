import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, alfredConfirmationsTable, alfredSessionsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { computeCost } from "../lib/ai/executor";
import { buildLiveConfig } from "../lib/alfred/instructions";
import { ALFRED_TOOL_DECLARATIONS } from "../lib/alfred/tool-declarations";
import { sweepAlfred } from "../lib/alfred/sessions";
import { startFakeGemini, type FakeGemini } from "../../test/fake-gemini";

// Sessioni di Alfred sull'app completa senza login (utente dev@localhost). Gemini è finto. Il limite di 10 avvii
// al minuto è disattivato salvo nella prova che lo verifica.

const limit = vi.hoisted(() => ({ real: false }));
vi.mock("../middlewares/rate-limit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../middlewares/rate-limit")>();
  return { ...orig, consumeAlfredSession: (userId: number) => (limit.real ? orig.consumeAlfredSession(userId) : true) };
});

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "GEMINI_NATIVE_BASE"] as const;
const saved: Record<string, string | undefined> = {};
const KEY = "AIza-test-key";

let base: string;
let server: http.Server;
let gemini: FakeGemini;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

async function otherUserId(): Promise<number> {
  const [user] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  return user!.id;
}

async function modelOf(userId: number, modelId: string, opts: { provider?: string; availability?: "available" | "unavailable" } = {}): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: `Account ${modelId}`,
      provider: opts.provider ?? "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnc: encryptSecret(KEY),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId, displayName: modelId, availability: opts.availability ?? "available" })
    .returning();
  return model!.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  gemini = await startFakeGemini();
  process.env["GEMINI_NATIVE_BASE"] = gemini.base;
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await gemini.close();
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM model_offers");
  await pool.query("DELETE FROM models");
  gemini.state.models = { "gemini-3.8-live": ["bidiGenerateContent"], "gemini-no-bidi-live": ["generateContent"] };
  gemini.state.modelRequests = [];
  gemini.state.modelApiKeys = [];
  gemini.state.modelStatus = null;
  gemini.state.tokenStatus = 200;
  gemini.state.tokenRequests = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildLiveConfig", () => {
  it("contiene nome, italiano, voce e strumenti; senza nome nessun null", () => {
    const text = JSON.stringify(buildLiveConfig({ voice: "Kore", userName: "Ivan" }));
    expect(text).toContain("Ivan");
    expect(text).toContain("italiano");
    const none = buildLiveConfig({ voice: "Kore", userName: null }) as { systemInstruction: { parts: { text: string }[] } };
    expect(none.systemInstruction.parts[0]!.text).not.toContain("null");
    expect(none.systemInstruction.parts[0]!.text).not.toContain("undefined");
    expect(ALFRED_TOOL_DECLARATIONS).toHaveLength(7);
  });
});

async function setup(opts: { price?: boolean } = {}) {
  const dev = await devUserId();
  const model = await modelOf(dev, "models/gemini-3.8-live");
  if (opts.price) await db.update(aiModelsTable).set({ priceInputPerMtok: "1.00", priceOutputPerMtok: "4.00" }).where(eq(aiModelsTable.id, model));
  await db.update(usersTable).set({ alfredAiModelId: model, alfredVoice: "Charon" }).where(eq(usersTable.id, dev));
  return { dev, model };
}

async function sessionRow(id: number) {
  const [r] = await db.select().from(alfredSessionsTable).where(eq(alfredSessionsTable.id, id));
  return r!;
}

describe("POST /alfred/sessions", () => {
  it("senza modello impostato risponde 409", async () => {
    await devUserId();
    const res = await api("POST", "/alfred/sessions");
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("scegli il modello di Alfred in Account");
  });

  it("con modello non più disponibile risponde 409 col messaggio dell'esecutore", async () => {
    const { dev } = await setup();
    // il modello salvato passa a un altro utente (o l'account sparisce): per l'esecutore non è più usabile
    const foreign = await modelOf(await otherUserId(), "gemini-altrui-live");
    await db.update(usersTable).set({ alfredAiModelId: foreign }).where(eq(usersTable.id, dev));
    const res = await api("POST", "/alfred/sessions");
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toBe("modello non disponibile");
  });

  it("con un tetto raggiunto (modello, account, utente) risponde 409 col motivo", async () => {
    const { dev, model } = await setup();
    await db.insert(alfredSessionsTable).values({ userId: dev, aiModelId: model, status: "closed", costUsd: "5.00000000" });
    const [m] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, model));
    for (const [what, set] of [
      ["del modello", () => db.update(aiModelsTable).set({ monthlyBudgetUsd: "1.00" }).where(eq(aiModelsTable.id, model))],
      ["dell'account AI", () => db.update(aiAccountsTable).set({ monthlyBudgetUsd: "1.00" }).where(eq(aiAccountsTable.id, m!.accountId))],
      ["mensile raggiunto", () => db.update(usersTable).set({ monthlyBudgetUsd: "1.00" }).where(eq(usersTable.id, dev))],
    ] as const) {
      await set();
      const res = await api("POST", "/alfred/sessions");
      expect(res.status, res.text).toBe(409);
      expect(res.json.error).toContain(what);
      await db.update(aiModelsTable).set({ monthlyBudgetUsd: null }).where(eq(aiModelsTable.id, model));
      await db.update(aiAccountsTable).set({ monthlyBudgetUsd: null }).where(eq(aiAccountsTable.id, m!.accountId));
      await db.update(usersTable).set({ monthlyBudgetUsd: null }).where(eq(usersTable.id, dev));
    }
  });

  it("avvia: token, scadenze, configurazione fissata, chiave dell'account", async () => {
    await setup();
    const before = Date.now();
    const res = await api("POST", "/alfred/sessions");
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ model: "gemini-3.8-live", voice: "Charon" });
    expect(res.json.token).toMatch(/^auth_tokens\/fake-\d+$/);
    expect(typeof res.json.sessionId).toBe("number");
    const req = gemini.state.tokenRequests[0]!;
    expect(req.apiKey).toBe(KEY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = req.body as any;
    expect(body.fieldMask).toBeUndefined();
    expect(body.uses).toBe(1);
    expect(Math.abs(Date.parse(body.expireTime) - (before + 30 * 60_000))).toBeLessThan(5000);
    expect(Math.abs(Date.parse(body.newSessionExpireTime) - (before + 60_000))).toBeLessThan(5000);
    const live = body.bidiGenerateContentSetup;
    expect(live.model).toBe("models/gemini-3.8-live");
    expect(live.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(live.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Charon");
    expect(live.systemInstruction.parts[0].text).toContain("italiano");
    expect(live.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual([
      "squadre_stato",
      "squadra_dettaglio",
      "bollettino",
      "coda_da_confermare",
      "scrivi_al_capo",
      "prepara_decisione",
      "conferma_decisione",
    ]);
    expect(live.inputAudioTranscription).toEqual({});
    expect(live.outputAudioTranscription).toEqual({});
    expect(live.sessionResumption).toEqual({});
    expect(live.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect((await sessionRow(res.json.sessionId)).status).toBe("active");
  });

  it("con il fuso del DB diverso da UTC gli orari della sessione sono quelli dell'API", async () => {
    await setup();
    await pool.query("SET TIME ZONE 'Etc/GMT-1'");
    try {
      const res = await api("POST", "/alfred/sessions");
      expect(res.status, res.text).toBe(201);
      const [row] = await db.select().from(alfredSessionsTable).where(eq(alfredSessionsTable.id, res.json.sessionId));
      expect(Math.abs(row!.startedAt.getTime() - Date.now())).toBeLessThan(2000);
      expect(Math.abs(row!.lastActivityAt.getTime() - Date.now())).toBeLessThan(2000);
    } finally {
      await pool.query("SET TIME ZONE 'UTC'");
    }
  });

  it("un secondo avvio chiude la prima sessione", async () => {
    await setup();
    const a = await api("POST", "/alfred/sessions");
    const b = await api("POST", "/alfred/sessions");
    expect((await sessionRow(a.json.sessionId)).status).toBe("closed");
    expect((await sessionRow(b.json.sessionId)).status).toBe("active");
  });

  it("l'undicesimo avvio in un minuto risponde 429", async () => {
    await setup();
    limit.real = true;
    try {
      for (let i = 0; i < 10; i++) expect((await api("POST", "/alfred/sessions")).status).toBe(201);
      expect((await api("POST", "/alfred/sessions")).status).toBe(429);
    } finally {
      limit.real = false;
    }
  });

  it("con Gemini che fallisce risponde 502 e non resta nessuna sessione attiva", async () => {
    await setup();
    gemini.state.tokenStatus = 500;
    const res = await api("POST", "/alfred/sessions");
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Gemini non raggiungibile");
    expect(await db.select().from(alfredSessionsTable)).toHaveLength(0);
    gemini.state.tokenStatus = 403;
    const rej = await api("POST", "/alfred/sessions");
    expect(rej.status).toBe(502);
    expect(rej.json.error).toContain("chiave Gemini rifiutata");
  });

  it("con un token personale risponde 403", async () => {
    const savedAllowed = process.env["ALLOWED_EMAILS"];
    try {
      process.env["ALLOWED_EMAILS"] = "token@example.com";
      const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
      const { token } = await createApiToken(user!.id, "Script", 30, ["mcp", "api:write"]);
      expect((await api("POST", "/alfred/sessions", undefined, token)).status).toBe(403);
      expect((await api("POST", "/alfred/sessions/1/usage", { promptTokens: 1, completionTokens: 1 }, token)).status).toBe(403);
    } finally {
      if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
      else process.env["ALLOWED_EMAILS"] = savedAllowed;
    }
  });
});

describe("avvii concorrenti", () => {
  it("due avvii insieme lasciano una sola sessione attiva", async () => {
    const { dev } = await setup();
    const [a, b] = await Promise.all([api("POST", "/alfred/sessions"), api("POST", "/alfred/sessions")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const rows = await db.select().from(alfredSessionsTable).where(eq(alfredSessionsTable.userId, dev));
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
  });
});

describe("renew", () => {
  it("usa il modello della sessione anche se l'utente ne ha scelto un altro", async () => {
    const { dev } = await setup();
    const s = await api("POST", "/alfred/sessions");
    gemini.state.models["gemini-altro-live"] = ["bidiGenerateContent"];
    const other = await modelOf(dev, "gemini-altro-live");
    await db.update(usersTable).set({ alfredAiModelId: other }).where(eq(usersTable.id, dev));
    gemini.state.tokenRequests = [];
    const r = await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.model).toBe("gemini-3.8-live");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gemini.state.tokenRequests[0]!.body as any).bidiGenerateContentSetup.model).toBe("models/gemini-3.8-live");
  });

  it("con resumptionHandle lo mette nel token; senza, sessionResumption resta vuoto", async () => {
    await setup();
    const s = await api("POST", "/alfred/sessions");
    gemini.state.tokenRequests = [];
    const r = await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`, { resumptionHandle: "handle-123" });
    expect(r.status, r.text).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gemini.state.tokenRequests[0]!.body as any).bidiGenerateContentSetup.sessionResumption).toEqual({ handle: "handle-123" });
    const r2 = await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`);
    expect(r2.status, r2.text).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gemini.state.tokenRequests[1]!.body as any).bidiGenerateContentSetup.sessionResumption).toEqual({});
  });

  it("un resumptionHandle vuoto o troppo lungo risponde 400", async () => {
    await setup();
    const s = await api("POST", "/alfred/sessions");
    const url = `/alfred/sessions/${s.json.sessionId}/renew`;
    expect((await api("POST", url, { resumptionHandle: "x".repeat(4097) })).status).toBe(400);
    expect((await api("POST", url, { resumptionHandle: "" })).status).toBe(400);
  });

  it("rilascia un nuovo token per la propria sessione attiva", async () => {
    await setup();
    const s = await api("POST", "/alfred/sessions");
    const r = await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ sessionId: s.json.sessionId, model: "gemini-3.8-live" });
    expect(r.json.token).not.toBe(s.json.token);
  });

  it("su sessione chiusa o di un altro utente risponde 404", async () => {
    const { dev, model } = await setup();
    const s = await api("POST", "/alfred/sessions");
    await api("POST", `/alfred/sessions/${s.json.sessionId}/close`);
    expect((await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`)).status).toBe(404);
    const other = await otherUserId();
    const [row] = await db.insert(alfredSessionsTable).values({ userId: other, aiModelId: model }).returning();
    const res = await api("POST", `/alfred/sessions/${row!.id}/renew`);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("sessione non trovata");
    expect(dev).toBeGreaterThan(0);
  });

  it("con un tetto raggiunto risponde 409 col motivo", async () => {
    const { dev } = await setup();
    const s = await api("POST", "/alfred/sessions");
    await db.update(usersTable).set({ monthlyBudgetUsd: "1.00" }).where(eq(usersTable.id, dev));
    await db.update(alfredSessionsTable).set({ costUsd: "5.00000000" }).where(eq(alfredSessionsTable.id, s.json.sessionId));
    const r = await api("POST", `/alfred/sessions/${s.json.sessionId}/renew`);
    expect(r.status, r.text).toBe(409);
    expect(r.json.error).toContain("Tetto di spesa mensile raggiunto");
  });
});

describe("usage e close", () => {
  it("tiene il massimo dei contatori e calcola il costo con i prezzi del modello", async () => {
    await setup({ price: true });
    const s = await api("POST", "/alfred/sessions");
    const id = s.json.sessionId;
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 100, completionTokens: 50 })).status).toBe(204);
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 80, completionTokens: 60 })).status).toBe(204);
    const row = await sessionRow(id);
    expect([row.promptTokens, row.completionTokens]).toEqual([100, 60]);
    expect(Number(row.costUsd)).toBeCloseTo(computeCost(100, 60, 1, 4)!, 8);
  });

  it("rifiuta contatori negativi o non interi con 400", async () => {
    await setup();
    const s = await api("POST", "/alfred/sessions");
    const id = s.json.sessionId;
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: -1, completionTokens: 0 })).status).toBe(400);
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 1.5, completionTokens: 0 })).status).toBe(400);
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 1e12, completionTokens: 0 })).status).toBe(400);
  });

  it("con il modello eliminato dopo l'avvio risponde 204 con costo null e la sessione resta chiudibile", async () => {
    const { model } = await setup({ price: true });
    const s = await api("POST", "/alfred/sessions");
    const id = s.json.sessionId;
    await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 10, completionTokens: 10 });
    await db.delete(aiModelsTable).where(eq(aiModelsTable.id, model));
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 20, completionTokens: 20 })).status).toBe(204);
    const row = await sessionRow(id);
    expect(row.costUsd).toBeNull();
    expect(row.promptTokens).toBe(20);
    expect((await api("POST", `/alfred/sessions/${id}/close`)).status).toBe(204);
    expect((await sessionRow(id)).status).toBe("closed");
  });

  it("due usage concorrenti non abbassano i contatori", async () => {
    await setup({ price: true });
    const id = (await api("POST", "/alfred/sessions")).json.sessionId;
    await Promise.all([
      api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 100, completionTokens: 50 }),
      api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 80, completionTokens: 60 }),
    ]);
    const row = await sessionRow(id);
    expect([row.promptTokens, row.completionTokens]).toEqual([100, 60]);
    expect(Number(row.costUsd)).toBeCloseTo(computeCost(100, 60, 1, 4)!, 8);
  });

  it("close chiude, poi usage risponde 404", async () => {
    await setup();
    const s = await api("POST", "/alfred/sessions");
    const id = s.json.sessionId;
    expect((await api("POST", `/alfred/sessions/${id}/close`)).status).toBe(204);
    expect((await sessionRow(id)).status).toBe("closed");
    expect((await api("POST", `/alfred/sessions/${id}/usage`, { promptTokens: 1, completionTokens: 1 })).status).toBe(404);
  });
});

describe("sweepAlfred", () => {
  it("chiude le sessioni inattive da 36 minuti e cancella le conferme scadute da 2 ore", async () => {
    const { dev, model } = await setup();
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    const [old] = await db.insert(alfredSessionsTable).values({ userId: dev, aiModelId: model, lastActivityAt: ago(36) }).returning();
    const [recent] = await db.insert(alfredSessionsTable).values({ userId: dev, aiModelId: model, lastActivityAt: ago(10) }).returning();
    const conf = (expiresAt: Date) => ({ userId: dev, sessionId: recent!.id, number: 1, decision: "approve" as const, codeHash: "h", expiresAt });
    await db.insert(alfredConfirmationsTable).values([conf(ago(120)), conf(ago(10))]);
    await sweepAlfred();
    expect((await sessionRow(old!.id)).status).toBe("closed");
    expect((await sessionRow(recent!.id)).status).toBe("active");
    expect(await db.select().from(alfredConfirmationsTable)).toHaveLength(1);
  });
});
