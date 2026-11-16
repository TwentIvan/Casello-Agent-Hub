import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  alfredSessionsTable,
  characterHistoryTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Modelli e tetti dei personaggi, sull'app completa senza login (AUTH_DISABLED=true: l'utente corrente è dev@localhost). Account e
// modelli si inseriscono a mano; nessuna chiamata ai provider (indirizzi https finti, mai contattati).

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const NO_SPEND = { alfredSpentUsd: 0, luciusSpentUsd: 0, alfredUnpricedCount: 0, luciusUnpricedCount: 0 };
const BP_DEFAULTS = { luciusBestPractice: "on_request", luciusSearchAiModelId: null, luciusSources: [], searchModels: [] };
const UNAVAILABLE = { error: "modello non disponibile" };

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

/** Modello su un account dell'utente indicato (`custom` se non detto). */
async function modelOf(userId: number, modelId: string, provider = "custom"): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: `Account ${modelId}`,
      provider,
      baseUrl: "https://llm.example.com/v1",
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId, displayName: modelId })
    .returning();
  return model!.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("modelli e tetti dei personaggi", () => {
  it("get_returns_nulls", async () => {
    const r = await api("GET", "/account/characters");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ...NO_SPEND, ...BP_DEFAULTS, alfredChatAiModelId: null, luciusAiModelId: null, alfredMonthlyBudgetUsd: null, luciusMonthlyBudgetUsd: null });
  });

  it("get_and_put_report_month_spend: spesa e senza prezzo di ciascun personaggio", async () => {
    const dev = await devUserId();
    await db.insert(alfredSessionsTable).values({ userId: dev, status: "closed", costUsd: "1.25" });
    await db.insert(characterHistoryTable).values({ userId: dev, character: "lucius", kind: "team_chat", refId: 1, title: "t", summary: "s", costUsd: "0.5" });
    await db.insert(characterHistoryTable).values({ userId: dev, character: "lucius", kind: "team_chat", refId: 2, title: "t", summary: "s", costUsd: null, tokensUsed: 10 });
    const expected = { alfredSpentUsd: 1.25, luciusSpentUsd: 0.5, alfredUnpricedCount: 0, luciusUnpricedCount: 1 };
    expect((await api("GET", "/account/characters")).json).toMatchObject(expected);
    const put = await api("PUT", "/account/characters", { alfredChatAiModelId: null, luciusAiModelId: null, alfredMonthlyBudgetUsd: 2, luciusMonthlyBudgetUsd: null });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject(expected);
  });

  it("put_saves_and_reads_back", async () => {
    const dev = await devUserId();
    const a = await modelOf(dev, "a");
    const l = await modelOf(dev, "l");
    const body = { alfredChatAiModelId: a, luciusAiModelId: l, alfredMonthlyBudgetUsd: 5, luciusMonthlyBudgetUsd: 2.5 };
    const put = await api("PUT", "/account/characters", body);
    expect(put.status, put.text).toBe(200);
    expect(put.json).toEqual({ ...NO_SPEND, ...BP_DEFAULTS, ...body });
    expect((await api("GET", "/account/characters")).json).toEqual({ ...NO_SPEND, ...BP_DEFAULTS, ...body });
    const cleared = { alfredChatAiModelId: null, luciusAiModelId: null, alfredMonthlyBudgetUsd: null, luciusMonthlyBudgetUsd: null };
    expect((await api("PUT", "/account/characters", cleared)).json).toEqual({ ...NO_SPEND, ...BP_DEFAULTS, ...cleared });
  });

  it("put_foreign_model_400", async () => {
    await devUserId();
    const theirs = await modelOf(await otherUserId(), "altrui");
    const r = await api("PUT", "/account/characters", { alfredChatAiModelId: theirs, luciusAiModelId: null, alfredMonthlyBudgetUsd: null, luciusMonthlyBudgetUsd: null });
    expect(r.status).toBe(400);
    expect(r.json).toEqual(UNAVAILABLE);
  });

  it("put_negative_budget_400", async () => {
    await devUserId();
    const r = await api("PUT", "/account/characters", { alfredChatAiModelId: null, luciusAiModelId: null, alfredMonthlyBudgetUsd: -1, luciusMonthlyBudgetUsd: null });
    expect(r.status).toBe(400);
  });

  it("token_forbidden_403", async () => {
    const savedAllowed = process.env["ALLOWED_EMAILS"];
    try {
      process.env["ALLOWED_EMAILS"] = "token@example.com";
      const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
      const { token } = await createApiToken(user!.id, "Script", 30, ["api:read", "api:write"]);
      const put = await api("PUT", "/account/characters", { alfredChatAiModelId: null, luciusAiModelId: null, alfredMonthlyBudgetUsd: null, luciusMonthlyBudgetUsd: null }, token);
      expect(put.status).toBe(403);
      expect(put.json).toEqual({ error: "operazione disponibile solo con il login" });
      expect((await api("GET", "/account/characters", undefined, token)).status).toBe(403);
    } finally {
      if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
      else process.env["ALLOWED_EMAILS"] = savedAllowed;
    }
  });

  describe("best practice di Lucius", () => {
    const BASE = { alfredChatAiModelId: null, luciusAiModelId: null, alfredMonthlyBudgetUsd: null, luciusMonthlyBudgetUsd: null };
    const src = (n: number) => ({ url: `https://example${n}.com/guide`, label: `Fonte ${n}` });

    it("put_saves_the_three_fields_and_get_lists_gemini_search_models", async () => {
      const dev = await devUserId();
      const g = await modelOf(dev, "gemini-3-flash", "gemini");
      await modelOf(dev, "gemini-live-audio", "gemini");
      await modelOf(dev, "altro", "custom");
      const body = { ...BASE, luciusBestPractice: "always", luciusSearchAiModelId: g, luciusSources: [src(1), src(2)] };
      const put = await api("PUT", "/account/characters", body);
      expect(put.status, put.text).toBe(200);
      expect(put.json).toMatchObject({ luciusBestPractice: "always", luciusSearchAiModelId: g, luciusSources: [src(1), src(2)] });
      expect(put.json.searchModels).toEqual([{ id: g, name: "gemini-3-flash", accountName: "Account gemini-3-flash" }]);
    });

    it("put_without_the_fields_leaves_them_unchanged", async () => {
      const dev = await devUserId();
      const g = await modelOf(dev, "gemini-3-flash", "gemini");
      await api("PUT", "/account/characters", { ...BASE, luciusBestPractice: "always", luciusSearchAiModelId: g, luciusSources: [src(1)] });
      const r = await api("PUT", "/account/characters", BASE);
      expect(r.status, r.text).toBe(200);
      expect(r.json).toMatchObject({ luciusBestPractice: "always", luciusSearchAiModelId: g, luciusSources: [src(1)] });
      const cleared = await api("PUT", "/account/characters", { ...BASE, luciusSearchAiModelId: null });
      expect(cleared.json.luciusSearchAiModelId).toBeNull();
    });

    it("http_source_400", async () => {
      await devUserId();
      const r = await api("PUT", "/account/characters", { ...BASE, luciusSources: [{ url: "http://example.com/x", label: "x" }] });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/^fonti curate non valide: /);
    });

    it("too_many_duplicate_or_bad_label_sources_400", async () => {
      await devUserId();
      const many = Array.from({ length: 31 }, (_, i) => src(i));
      expect((await api("PUT", "/account/characters", { ...BASE, luciusSources: many })).status).toBe(400);
      const dup = await api("PUT", "/account/characters", { ...BASE, luciusSources: [src(1), src(1)] });
      expect(dup.status).toBe(400);
      expect(dup.json.error).toMatch(/^fonti curate non valide: /);
      for (const label of ["", "a\nb", "x".repeat(81)]) {
        const r = await api("PUT", "/account/characters", { ...BASE, luciusSources: [{ url: "https://example.com/a", label }] });
        expect(r.status, label).toBe(400);
      }
    });

    it("non_gemini_or_foreign_search_model_400", async () => {
      const dev = await devUserId();
      const msg = { error: "modello di ricerca non valido: scegli un modello Gemini dei tuoi account" };
      const ds = await modelOf(dev, "deepseek-chat", "deepseek");
      const r = await api("PUT", "/account/characters", { ...BASE, luciusSearchAiModelId: ds });
      expect(r.status).toBe(400);
      expect(r.json).toEqual(msg);
      const theirs = await modelOf(await otherUserId(), "g-altrui", "gemini");
      expect((await api("PUT", "/account/characters", { ...BASE, luciusSearchAiModelId: theirs })).json).toEqual(msg);
    });

    it("best_practice_default_follows_mode", async () => {
      const dev = await devUserId();
      const { luciusBestPracticeDefault } = await import("../lib/characters/settings");
      expect(await luciusBestPracticeDefault(dev)).toBe(false);
      await api("PUT", "/account/characters", { ...BASE, luciusBestPractice: "always" });
      expect(await luciusBestPracticeDefault(dev)).toBe(true);
    });
  });
});
