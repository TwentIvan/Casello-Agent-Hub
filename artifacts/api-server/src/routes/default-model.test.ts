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

// Modello predefinito dell'utente e ripiego «scelto → predefinito → nessuno» per gli agenti che Casello
// crea, sull'app completa senza login (AUTH_DISABLED=true: l'utente corrente è dev@localhost). Account e
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

async function createApp(extra: Record<string, unknown> = {}) {
  return api("POST", "/apps", { name: `App ${Math.random().toString(36).slice(2, 8)}`, baseUrl: "https://app.example.com", ...extra });
}

async function generalOf(appId: number) {
  const [general] = await db.select().from(agentsTable).where(and(eq(agentsTable.appId, appId), eq(agentsTable.role, "general")));
  return general!;
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

describe("modello predefinito dell'utente", () => {
  it("imposta e legge il predefinito; modello altrui → 400; null lo toglie", async () => {
    const dev = await devUserId();
    const mine = await modelOf(dev, "mio");
    const theirs = await modelOf(await otherUserId(), "altrui");

    expect((await api("GET", "/account/default-model")).json).toEqual({ aiModelId: null });

    const set = await api("PUT", "/account/default-model", { aiModelId: mine });
    expect(set.status, set.text).toBe(200);
    expect(set.json).toEqual({ aiModelId: mine });
    expect((await api("GET", "/account/default-model")).json).toEqual({ aiModelId: mine });

    for (const aiModelId of [theirs, 999_999]) {
      const ko = await api("PUT", "/account/default-model", { aiModelId });
      expect(ko.status).toBe(400);
      expect(ko.json).toEqual(UNAVAILABLE);
    }
    expect((await api("GET", "/account/default-model")).json).toEqual({ aiModelId: mine });

    const cleared = await api("PUT", "/account/default-model", { aiModelId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ aiModelId: null });
    expect((await api("GET", "/account/default-model")).json).toEqual({ aiModelId: null });
  });

  it("PUT con un token → 403 solo login", async () => {
    const savedAllowed = process.env["ALLOWED_EMAILS"];
    try {
      process.env["ALLOWED_EMAILS"] = "token@example.com";
      const [user] = await db.insert(usersTable).values({ email: "token@example.com", name: "Token" }).returning();
      const model = await modelOf(user!.id, "del-token");
      const { token } = await createApiToken(user!.id, "Script", 30, ["api:read", "api:write"]);
      const put = await api("PUT", "/account/default-model", { aiModelId: model }, token);
      expect(put.status).toBe(403);
      expect(put.json).toEqual({ error: "operazione disponibile solo con il login" });
      expect((await api("GET", "/account/default-model", undefined, token)).status).toBe(403);
      const [row] = await db.select().from(usersTable).where(eq(usersTable.id, user!.id));
      expect(row!.defaultAiModelId).toBeNull();
    } finally {
      if (savedAllowed === undefined) delete process.env["ALLOWED_EMAILS"];
      else process.env["ALLOWED_EMAILS"] = savedAllowed;
    }
  });

  it("predefinito eliminato → null", async () => {
    const dev = await devUserId();
    const mine = await modelOf(dev, "mio");
    await api("PUT", "/account/default-model", { aiModelId: mine });
    await db.delete(aiModelsTable).where(eq(aiModelsTable.id, mine));
    expect((await api("GET", "/account/default-model")).json).toEqual({ aiModelId: null });
  });
});

describe("ripiego per gli agenti creati: scelto → predefinito → nessuno", () => {
  it("creazione app: scelto, poi predefinito, poi nessuno", async () => {
    const dev = await devUserId();
    const chosen = await modelOf(dev, "scelto");
    const fallback = await modelOf(dev, "predefinito");
    const theirs = await modelOf(await otherUserId(), "altrui");

    // Nessun predefinito, nessuna scelta: agente generale senza modello
    let res = await createApp();
    expect(res.status, res.text).toBe(201);
    expect(await generalOf(res.json.id)).toMatchObject({ aiModelId: null, model: "" });

    await api("PUT", "/account/default-model", { aiModelId: fallback });
    res = await createApp();
    expect(await generalOf(res.json.id)).toMatchObject({ aiModelId: fallback, model: "predefinito" });

    res = await createApp({ generalAgentAiModelId: chosen });
    expect(res.status, res.text).toBe(201);
    expect(await generalOf(res.json.id)).toMatchObject({ aiModelId: chosen, model: "scelto" });

    // Un modello altrui: 400 e nessuna app creata
    const before = (await api("GET", "/apps")).json.length;
    const ko = await createApp({ generalAgentAiModelId: theirs });
    expect(ko.status).toBe(400);
    expect(ko.json).toEqual(UNAVAILABLE);
    expect((await api("GET", "/apps")).json.length).toBe(before);
  });

  it("approvazione di un agente nuovo con aiModelId scelto o predefinito; agente esistente mantiene il modello", async () => {
    const dev = await devUserId();
    const chosen = await modelOf(dev, "scelto");
    const fallback = await modelOf(dev, "predefinito");
    const theirs = await modelOf(await otherUserId(), "altrui");
    const appId = (await createApp()).json.id as number;
    const [analysis] = await db
      .insert(analysesTable)
      .values({ appId, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
      .returning();
    let seq = 0;
    const agentItem = async (area: string, diff: "new" | "changed" = "new") => {
      seq += 1;
      const payload = { role: "area", area, name: `Agente ${area}`, systemPrompt: `prompt ${seq}`, defaultIdentity: "user", toolNames: [] };
      const [row] = await db
        .insert(analysisItemsTable)
        .values({ analysisId: analysis!.id, chapter: "agent", ref: `agent:${seq}`, position: seq, payload, diff })
        .returning();
      return row!.id;
    };
    const areaAgent = async (area: string) => {
      const [row] = await db.select().from(agentsTable).where(and(eq(agentsTable.appId, appId), eq(agentsTable.area, area)));
      return row!;
    };

    // Modello altrui: 400, l'elemento resta in attesa e nessun agente nasce
    const rejected = await agentItem("Rifiutata");
    const ko = await api("PATCH", `/analysis-items/${rejected}`, { status: "approved", aiModelId: theirs });
    expect(ko.status).toBe(400);
    expect(ko.json).toEqual(UNAVAILABLE);
    const [still] = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.id, rejected));
    expect(still!.status).toBe("pending");

    // Scelto
    let res = await api("PATCH", `/analysis-items/${await agentItem("Squadre")}`, { status: "approved", aiModelId: chosen });
    expect(res.status, res.text).toBe(200);
    expect(await areaAgent("Squadre")).toMatchObject({ aiModelId: chosen, model: "scelto" });

    // Senza scelta né predefinito: nessun modello
    res = await api("PATCH", `/analysis-items/${await agentItem("Partite")}`, { status: "approved" });
    expect(res.status, res.text).toBe(200);
    expect(await areaAgent("Partite")).toMatchObject({ aiModelId: null, model: "" });

    // Predefinito
    await api("PUT", "/account/default-model", { aiModelId: fallback });
    res = await api("PATCH", `/analysis-items/${await agentItem("Rose")}`, { status: "approved" });
    expect(res.status, res.text).toBe(200);
    expect(await areaAgent("Rose")).toMatchObject({ aiModelId: fallback, model: "predefinito" });

    // Agente esistente aggiornato dall'architetto: mantiene il modello, anche con un aiModelId nel corpo
    res = await api("PATCH", `/analysis-items/${await agentItem("Squadre", "changed")}`, { status: "approved", aiModelId: fallback });
    expect(res.status, res.text).toBe(200);
    expect(await areaAgent("Squadre")).toMatchObject({ aiModelId: chosen, model: "scelto", status: "active" });
  });

  it("POST /agents senza aiModelId usa il predefinito; con un modello altrui 400", async () => {
    const dev = await devUserId();
    const fallback = await modelOf(dev, "predefinito");
    const theirs = await modelOf(await otherUserId(), "altrui");
    const appId = (await createApp()).json.id as number;

    let res = await api("POST", "/agents", { appId, name: "Senza", model: "ignorato" });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ aiModelId: null, model: "" });

    await api("PUT", "/account/default-model", { aiModelId: fallback });
    res = await api("POST", "/agents", { appId, name: "Predefinito" });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ aiModelId: fallback, model: "predefinito" });

    const ko = await api("POST", "/agents", { appId, name: "Altrui", aiModelId: theirs });
    expect(ko.status).toBe(400);
    expect(ko.json).toEqual(UNAVAILABLE);
    const names = (await db.select().from(agentsTable).where(eq(agentsTable.appId, appId))).map((a) => a.name);
    expect(names).not.toContain("Altrui");
  });

  it("predefinito non più dell'utente (account di un altro) → agente senza modello", async () => {
    const dev = await devUserId();
    const other = await otherUserId();
    const fallback = await modelOf(dev, "predefinito");
    await api("PUT", "/account/default-model", { aiModelId: fallback });
    // L'account passa a un altro utente: il predefinito resta salvato ma non si usa più
    const [model] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, fallback));
    await db.update(aiAccountsTable).set({ userId: other }).where(eq(aiAccountsTable.id, model!.accountId));

    const app = await createApp();
    expect(app.status, app.text).toBe(201);
    expect(await generalOf(app.json.id)).toMatchObject({ aiModelId: null, model: "" });
    const agent = await api("POST", "/agents", { appId: app.json.id, name: "Area" });
    expect(agent.status, agent.text).toBe(201);
    expect(agent.json).toMatchObject({ aiModelId: null, model: "" });
  });
});
