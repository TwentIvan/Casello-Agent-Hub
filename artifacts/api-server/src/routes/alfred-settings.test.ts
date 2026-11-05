import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { isAlfredModelName } from "../lib/alfred/config";
import { startFakeGemini, type FakeGemini } from "../../test/fake-gemini";

// Modello e voce di Alfred sull'app completa senza login (AUTH_DISABLED=true: utente dev@localhost). Gemini è finto:
// GEMINI_NATIVE_BASE punta al finto, gli account hanno un indirizzo https segnaposto mai contattato.

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
  gemini.state.models = { "gemini-3.8-live": ["bidiGenerateContent"], "gemini-no-bidi-live": ["generateContent"] };
  gemini.state.modelRequests = [];
  gemini.state.modelApiKeys = [];
  gemini.state.modelStatus = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isAlfredModelName", () => {
  it("riconosce i modelli Live dal nome", () => {
    expect(isAlfredModelName("models/gemini-3.8-live")).toBe(true);
    expect(isAlfredModelName("gemini-2.5-flash-native-audio-latest")).toBe(true);
    expect(isAlfredModelName("models/gemini-3.5-transcribe-live")).toBe(false);
    expect(isAlfredModelName("gemini-3.5-live-translate-preview")).toBe(false);
    expect(isAlfredModelName("gemini-2.5-flash")).toBe(false);
  });
});

describe("GET /account/alfred", () => {
  it("elenca solo i modelli idonei dell'utente", async () => {
    const dev = await devUserId();
    const live = await modelOf(dev, "models/gemini-3.8-live");
    await modelOf(dev, "gemini-2.5-flash");
    await modelOf(dev, "gemini-custom-live", { provider: "custom" });
    await modelOf(await otherUserId(), "gemini-altrui-live");
    const res = await api("GET", "/account/alfred");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      aiModelId: null,
      voice: "Kore",
      models: [{ id: live, name: "gemini-3.8-live", accountName: "Account models/gemini-3.8-live" }],
    });
    expect(gemini.state.modelRequests).toEqual([]);
  });
});

describe("PUT /account/alfred", () => {
  it("imposta modello e voce, verificando con Gemini (nome senza prefisso, chiave dell'account)", async () => {
    const dev = await devUserId();
    const live = await modelOf(dev, "models/gemini-3.8-live");
    const put = await api("PUT", "/account/alfred", { aiModelId: live, voice: "Charon" });
    expect(put.status, put.text).toBe(200);
    expect(gemini.state.modelRequests).toEqual(["gemini-3.8-live"]);
    expect(gemini.state.modelApiKeys).toEqual([KEY]);
    const get = await api("GET", "/account/alfred");
    expect(get.json.aiModelId).toBe(live);
    expect(get.json.voice).toBe("Charon");
    expect(put.json).toEqual(get.json);
  });

  it("modello senza bidiGenerateContent o assente per Gemini → 400 non adatto", async () => {
    const dev = await devUserId();
    const nobidi = await modelOf(dev, "gemini-no-bidi-live");
    const missing = await modelOf(dev, "gemini-sconosciuto-live");
    const flash = await modelOf(dev, "gemini-2.5-flash");
    for (const aiModelId of [nobidi, missing, flash]) {
      const res = await api("PUT", "/account/alfred", { aiModelId });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "modello non adatto ad Alfred" });
    }
  });

  it("modello altrui → 400; voce sconosciuta → 400 e nulla salvato", async () => {
    const dev = await devUserId();
    const theirs = await modelOf(await otherUserId(), "gemini-3.8-live");
    const mine = await modelOf(dev, "gemini-3.8-live");
    const other = await api("PUT", "/account/alfred", { aiModelId: theirs });
    expect(other.status).toBe(400);
    expect(other.json).toEqual({ error: "modello non disponibile" });
    const voice = await api("PUT", "/account/alfred", { aiModelId: mine, voice: "Pippo" });
    expect(voice.status).toBe(400);
    expect(voice.json).toEqual({ error: "voce non disponibile" });
    expect((await api("GET", "/account/alfred")).json.aiModelId).toBeNull();
  });

  it("Gemini rifiuta la chiave → 502; spento → 502", async () => {
    const dev = await devUserId();
    const mine = await modelOf(dev, "gemini-3.8-live");
    gemini.state.modelStatus = 403;
    const denied = await api("PUT", "/account/alfred", { aiModelId: mine });
    expect(denied.status).toBe(502);
    expect(denied.json).toEqual({ error: "chiave Gemini rifiutata: controlla l'account in Account" });

    gemini.state.modelStatus = null;
    await gemini.close();
    try {
      const down = await api("PUT", "/account/alfred", { aiModelId: mine });
      expect(down.status).toBe(502);
      expect(down.json).toEqual({ error: "Gemini non raggiungibile" });
    } finally {
      gemini = await startFakeGemini();
      process.env["GEMINI_NATIVE_BASE"] = gemini.base;
      gemini.state.models = { "gemini-3.8-live": ["bidiGenerateContent"] };
    }
  });

  it("null toglie il modello senza chiamare Gemini; la voce senza modello nuovo resta", async () => {
    const dev = await devUserId();
    const mine = await modelOf(dev, "gemini-3.8-live");
    await api("PUT", "/account/alfred", { aiModelId: mine, voice: "Puck" });
    gemini.state.modelRequests = [];
    const res = await api("PUT", "/account/alfred", { aiModelId: null });
    expect(res.status, res.text).toBe(200);
    expect(res.json.aiModelId).toBeNull();
    expect(res.json.voice).toBe("Puck");
    expect(gemini.state.modelRequests).toEqual([]);
  });

  it("con un token personale → 403 solo login", async () => {
    const savedAllowed = process.env["ALLOWED_EMAILS"];
    try {
      process.env["ALLOWED_EMAILS"] = "token@example.com";
      const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
      const { token } = await createApiToken(user!.id, "Script", 30, ["api:read", "api:write"]);
      const put = await api("PUT", "/account/alfred", { aiModelId: null }, token);
      expect(put.status).toBe(403);
      expect(put.json).toEqual({ error: "operazione disponibile solo con il login" });
      expect((await api("GET", "/account/alfred", undefined, token)).status).toBe(403);
    } finally {
      if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
      else process.env["ALLOWED_EMAILS"] = savedAllowed;
    }
  });
});
