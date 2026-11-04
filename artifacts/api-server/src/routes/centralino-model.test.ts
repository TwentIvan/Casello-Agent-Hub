import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  analysisItemsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Modello del centralino dell'utente, sull'app completa senza login (AUTH_DISABLED=true: l'utente corrente è dev@localhost). Account e
// modelli si inseriscono a mano; nessuna chiamata ai provider (indirizzi https finti, mai contattati).

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
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

/** Modello su un account `custom` dell'utente indicato. */
async function modelOf(userId: number, modelId: string): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: `Account ${modelId}`,
      provider: "custom",
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


describe("modello del centralino", () => {
  it("imposta e legge; modello altrui → 400; null lo toglie; indipendente dal predefinito", async () => {
    const dev = await devUserId();
    const mine = await modelOf(dev, "mio");
    const theirs = await modelOf(await otherUserId(), "altrui");

    expect((await api("GET", "/account/centralino-model")).json).toEqual({ aiModelId: null });
    const set = await api("PUT", "/account/centralino-model", { aiModelId: mine });
    expect(set.status, set.text).toBe(200);
    expect(set.json).toEqual({ aiModelId: mine });
    expect((await api("GET", "/account/centralino-model")).json).toEqual({ aiModelId: mine });
    expect((await api("GET", "/account/default-model")).json).toEqual({ aiModelId: null });

    for (const aiModelId of [theirs, 999_999]) {
      const ko = await api("PUT", "/account/centralino-model", { aiModelId });
      expect(ko.status).toBe(400);
      expect(ko.json).toEqual(UNAVAILABLE);
    }
    expect((await api("GET", "/account/centralino-model")).json).toEqual({ aiModelId: mine });

    const cleared = await api("PUT", "/account/centralino-model", { aiModelId: null });
    expect(cleared.json).toEqual({ aiModelId: null });
  });

  it("con un token → 403 solo login", async () => {
    const savedAllowed = process.env["ALLOWED_EMAILS"];
    try {
      process.env["ALLOWED_EMAILS"] = "token@example.com";
      const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
      const model = await modelOf(user!.id, "del-token");
      const { token } = await createApiToken(user!.id, "Script", 30, ["api:read", "api:write"]);
      const put = await api("PUT", "/account/centralino-model", { aiModelId: model }, token);
      expect(put.status).toBe(403);
      expect(put.json).toEqual({ error: "operazione disponibile solo con il login" });
      expect((await api("GET", "/account/centralino-model", undefined, token)).status).toBe(403);
      const [row] = await db.select().from(usersTable).where(eq(usersTable.id, user!.id));
      expect(row!.centralinoAiModelId).toBeNull();
    } finally {
      if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
      else process.env["ALLOWED_EMAILS"] = savedAllowed;
    }
  });

  it("modello eliminato → null", async () => {
    const dev = await devUserId();
    const mine = await modelOf(dev, "mio");
    await api("PUT", "/account/centralino-model", { aiModelId: mine });
    await db.delete(aiModelsTable).where(eq(aiModelsTable.id, mine));
    expect((await api("GET", "/account/centralino-model")).json).toEqual({ aiModelId: null });
  });
});
