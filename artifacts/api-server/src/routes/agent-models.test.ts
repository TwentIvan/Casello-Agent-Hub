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
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Mappa dei modelli degli agenti di un'app (PUT /apps/:id/agent-models), sull'app completa senza login (AUTH_DISABLED=true: l'utente corrente è dev@localhost). Account e
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


async function areaAgent(appId: number, name: string) {
  const res = await api("POST", "/agents", { appId, name, systemPrompt: "p" });
  expect(res.status, res.text).toBe(201);
  return res.json.id as number;
}

async function stored(id: number) {
  const [a] = await db.select({ aiModelId: agentsTable.aiModelId, model: agentsTable.model }).from(agentsTable).where(eq(agentsTable.id, id));
  return a!;
}

describe("mappa dei modelli degli agenti di un'app", () => {
  it("aggiorna più agenti e azzera con null", async () => {
    const dev = await devUserId();
    const m1 = await modelOf(dev, "uno");
    const m2 = await modelOf(dev, "due");
    const app = (await createApp()).json.id as number;
    const general = (await generalOf(app)).id;
    const area = await areaAgent(app, "Area");

    const ok = await api("PUT", `/apps/${app}/agent-models`, {
      assignments: [{ agentId: general, aiModelId: m1 }, { agentId: area, aiModelId: m2 }],
    });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.map((a: { id: number; aiModelId: number }) => [a.id, a.aiModelId]).sort()).toEqual([[general, m1], [area, m2]].sort());
    expect(await stored(general)).toEqual({ aiModelId: m1, model: "uno" });
    expect(await stored(area)).toEqual({ aiModelId: m2, model: "due" });

    const cleared = await api("PUT", `/apps/${app}/agent-models`, { assignments: [{ agentId: area, aiModelId: null }] });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.json).toHaveLength(1);
    expect(cleared.json[0].aiModelId).toBeNull();
    expect(await stored(area)).toEqual({ aiModelId: null, model: "" });
    expect(await stored(general)).toEqual({ aiModelId: m1, model: "uno" });
  });

  it("app inesistente → 404", async () => {
    const res = await api("PUT", "/apps/999999/agent-models", { assignments: [{ agentId: 1, aiModelId: null }] });
    expect(res.status).toBe(404);
  });

  it("agente di un'altra app → 400 senza modifiche", async () => {
    const dev = await devUserId();
    const m1 = await modelOf(dev, "uno");
    const app = (await createApp()).json.id as number;
    const other = (await createApp()).json.id as number;
    const mine = (await generalOf(app)).id;
    const foreign = (await generalOf(other)).id;
    const res = await api("PUT", `/apps/${app}/agent-models`, {
      assignments: [{ agentId: mine, aiModelId: m1 }, { agentId: foreign, aiModelId: m1 }],
    });
    expect(res.status).toBe(400);
    expect(await stored(mine)).toEqual({ aiModelId: null, model: "" });
    expect(await stored(foreign)).toEqual({ aiModelId: null, model: "" });
  });

  it("modello altrui → 400 senza modifiche", async () => {
    const dev = await devUserId();
    const m1 = await modelOf(dev, "uno");
    const theirs = await modelOf(await otherUserId(), "altrui");
    const app = (await createApp()).json.id as number;
    const general = (await generalOf(app)).id;
    const area = await areaAgent(app, "Area");
    const res = await api("PUT", `/apps/${app}/agent-models`, {
      assignments: [{ agentId: general, aiModelId: m1 }, { agentId: area, aiModelId: theirs }],
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual(UNAVAILABLE);
    expect(await stored(general)).toEqual({ aiModelId: null, model: "" });
    expect(await stored(area)).toEqual({ aiModelId: null, model: "" });
  });

  it("agentId ripetuti → 400", async () => {
    const dev = await devUserId();
    const m1 = await modelOf(dev, "uno");
    const app = (await createApp()).json.id as number;
    const general = (await generalOf(app)).id;
    const res = await api("PUT", `/apps/${app}/agent-models`, {
      assignments: [{ agentId: general, aiModelId: m1 }, { agentId: general, aiModelId: null }],
    });
    expect(res.status).toBe(400);
    expect(await stored(general)).toEqual({ aiModelId: null, model: "" });
  });
});
