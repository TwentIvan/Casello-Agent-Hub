import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  characterConversationsTable,
  characterMessagesTable,
  characterProposalsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { registerSubject } from "../lib/characters/registry";
import { toolOk, type SubjectHandler } from "../lib/characters/types";

// Route delle conversazioni dei personaggi su un'app Express vera senza login (AUTH_DISABLED=true). I turni girano
// in background: afterEach li attende. Il limite è di 10 messaggi/min per utente e personaggio: il test del 429 viene per ultimo.

const ACCOUNT_KEY = "sk-CHIAVE-PERSONAGGI-ROUTE";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let fake: FakeProvider;
let restoreLoopback: () => void;
let unregister: () => void;
let userId: number;
let modelId: number;
let subjectExists = true;

const fakeSkill: SubjectHandler = {
  character: "lucius",
  type: "skill",
  resolve: async (_u, subjectId) => (subjectExists && subjectId === "prova" ? { title: "Skill di prova" } : null),
  context: async () => [],
  tools: [],
  runTool: async () => toolOk(null),
};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function createConv(extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/character-conversations", { character: "lucius", subjectType: "area_agents", ...extra });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number };
}

async function waitIdle(id: number) {
  for (let i = 0; i < 200; i++) {
    const res = await api("GET", `/character-conversations/${id}`);
    if (res.json?.turnStatus === "idle") return res.json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("turno non terminato");
}

async function strangerModel() {
  const [stranger] = await db.insert(usersTable).values({ email: "altro@x.it" }).returning();
  const [acc] = await db
    .insert(aiAccountsTable)
    .values({ userId: stranger!.id, name: "Altrui", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("k"), status: "ok" })
    .returning();
  const [m] = await db.insert(aiModelsTable).values({ accountId: acc!.id, modelId: "x", displayName: "X" }).returning();
  return { userId: stranger!.id, modelId: m!.id };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  restoreLoopback = allowTestLoopback();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
  unregister = registerSubject(fakeSkill);
});

afterAll(async () => {
  unregister();
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  restoreLoopback();
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  subjectExists = true;
  fake = await startFakeProvider({ apiKey: ACCOUNT_KEY });
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(ACCOUNT_KEY), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" }).returning();
  modelId = model!.id;
  await db.update(usersTable).set({ luciusAiModelId: modelId, alfredChatAiModelId: modelId }).where(eq(usersTable.id, userId));
});

afterEach(async () => {
  for (let i = 0; i < 200; i++) {
    const running = await db.select({ id: characterConversationsTable.id }).from(characterConversationsTable).where(eq(characterConversationsTable.turnStatus, "running"));
    if (!running.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await fake.close();
});

describe("conversazioni", () => {
  it("create_and_list: crea, elenca (filtri, senza filo di Alfred), legge, rinomina ed elimina", async () => {
    const created = await api("POST", "/character-conversations", { character: "lucius", subjectType: "area_agents" });
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ character: "lucius", subjectType: "area_agents", subjectId: null, aiModelId: modelId, turnStatus: "idle", costUsd: null, tokensUsed: 0 });
    expect(created.json).not.toHaveProperty("userId");
    const other = await createConv({ subjectType: "skill", subjectId: "prova" });
    await api("GET", "/characters/alfred/thread");
    const list = await api("GET", "/character-conversations?character=lucius");
    expect(list.json.map((c: { id: number }) => c.id)).toEqual([other.id, created.json.id]);
    const filtered = await api("GET", "/character-conversations?character=lucius&subjectType=skill&subjectId=prova");
    expect(filtered.json.map((c: { id: number }) => c.id)).toEqual([other.id]);
    expect((await api("GET", "/character-conversations?character=alfred")).json).toEqual([]);
    expect((await api("GET", "/character-conversations")).status).toBe(400);
    const detail = await api("GET", `/character-conversations/${other.id}`);
    expect(detail.json).toMatchObject({ id: other.id, messages: [], proposals: [], subjectGone: false, subjectTitle: "Skill di prova" });
    const renamed = await api("PATCH", `/character-conversations/${other.id}`, { title: "Nuovo titolo" });
    expect(renamed.json.title).toBe("Nuovo titolo");
    expect((await api("PATCH", `/character-conversations/${other.id}`, { title: "" })).status).toBe(400);
    expect((await api("PATCH", `/character-conversations/${other.id}`, { title: "x".repeat(81) })).status).toBe(400);
    expect((await api("DELETE", `/character-conversations/${other.id}`)).status).toBe(204);
    expect((await api("GET", `/character-conversations/${other.id}`)).status).toBe(404);
  });

  it("il filo di Alfred: GET lo crea, restart lo archivia; non si elimina da aperto, non si crea da POST", async () => {
    const t1 = await api("GET", "/characters/alfred/thread");
    expect(t1.status, t1.text).toBe(200);
    expect(t1.json).toMatchObject({ character: "alfred", subjectType: "alfred_thread", subjectGone: false, messages: [] });
    expect((await api("GET", "/characters/alfred/thread")).json.id).toBe(t1.json.id);
    expect((await api("DELETE", `/character-conversations/${t1.json.id}`)).status).toBe(409);
    expect((await api("POST", "/character-conversations", { character: "alfred", subjectType: "alfred_thread" })).status).toBe(400);
    const t2 = await api("POST", "/characters/alfred/thread/restart");
    expect(t2.json.id).not.toBe(t1.json.id);
    expect((await api("DELETE", `/character-conversations/${t1.json.id}`)).status).toBe(204);
  });

  it("argomento inesistente o di un altro personaggio → 404", async () => {
    expect((await api("POST", "/character-conversations", { character: "lucius", subjectType: "skill", subjectId: "non-c-e" })).status).toBe(404);
    expect((await api("POST", "/character-conversations", { character: "alfred", subjectType: "area_agents" })).status).toBe(404);
  });

  it("foreign_conversation_404: lettura, modifica, eliminazione, messaggio e decisione; assenti dall'elenco", async () => {
    const stranger = await strangerModel();
    const [conv] = await db.insert(characterConversationsTable).values({ userId: stranger.userId, character: "lucius", subjectType: "area_agents", aiModelId: null, title: "" }).returning();
    const [msg] = await db.insert(characterMessagesTable).values({ conversationId: conv!.id, role: "assistant", content: "ok" }).returning();
    const [p] = await db.insert(characterProposalsTable).values({ conversationId: conv!.id, messageId: msg!.id, kind: "handoff", payload: {}, rationale: "" }).returning();
    expect((await api("GET", `/character-conversations/${conv!.id}`)).status).toBe(404);
    expect((await api("PATCH", `/character-conversations/${conv!.id}`, { title: "x" })).status).toBe(404);
    expect((await api("DELETE", `/character-conversations/${conv!.id}`)).status).toBe(404);
    expect((await api("POST", `/character-conversations/${conv!.id}/messages`, { content: "ciao" })).status).toBe(404);
    expect((await api("POST", `/character-proposals/${p!.id}/decision`, { action: "accept" })).status).toBe(404);
    expect((await api("GET", "/character-conversations?character=lucius")).json).toEqual([]);
  });

  it("patch_foreign_model_400: il modello deve essere di un proprio account; null lo toglie", async () => {
    const { id } = await createConv();
    const stranger = await strangerModel();
    const bad = await api("PATCH", `/character-conversations/${id}`, { aiModelId: stranger.modelId });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("modello non disponibile");
    expect((await api("PATCH", `/character-conversations/${id}`, { aiModelId: null })).json.aiModelId).toBeNull();
    expect((await api("PATCH", `/character-conversations/${id}`, { aiModelId: modelId })).json.aiModelId).toBe(modelId);
  });
});

describe("messaggi", () => {
  it("202, turno in background, risposta del personaggio, pageContext conservato", async () => {
    fake.chatReply = () => ({ content: "Ciao, sono Lucius.", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    const { id } = await createConv();
    const sent = await api("POST", `/character-conversations/${id}/messages`, { content: "  Ciao  ", pageContext: { page: "agents", id: "7" } });
    expect(sent.status, sent.text).toBe(202);
    expect(sent.json).toMatchObject({ role: "user", content: "Ciao", error: false, pageContext: { page: "agents", id: "7" } });
    expect(sent.json).not.toHaveProperty("tokens");
    const done = await waitIdle(id);
    expect(done.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(done.messages[1].content).toBe("Ciao, sono Lucius.");
    expect(done.messages[1].pageContext).toBeNull();
    expect(done.tokensUsed).toBe(110);
    expect(done.title).toBe("Ciao");
  });

  it("send_empty_400: vuoto o solo spazi", async () => {
    const { id } = await createConv();
    expect((await api("POST", `/character-conversations/${id}/messages`, { content: "" })).status).toBe(400);
    const blank = await api("POST", `/character-conversations/${id}/messages`, { content: "   " });
    expect(blank.status).toBe(400);
    expect(blank.json.error).toBe("messaggio vuoto");
  });

  it("send_too_long_400: 8 001 caratteri; pageContext non valido → 400", async () => {
    const { id } = await createConv();
    expect((await api("POST", `/character-conversations/${id}/messages`, { content: "a".repeat(8001) })).status).toBe(400);
    for (const pageContext of [{ page: "Agenti" }, { page: "" }, { page: "a".repeat(41) }, { page: "agents", id: "" }, { page: "agents", id: "i".repeat(101) }]) {
      expect((await api("POST", `/character-conversations/${id}/messages`, { content: "ciao", pageContext })).status, JSON.stringify(pageContext)).toBe(400);
    }
  });

  it("host_page_context_400: host con titolo lungo o con page diversa da host, page host senza host", async () => {
    const { id } = await createConv();
    const host = { app: "hub-up", page: "workitem", id: "1174", title: "Fix ordini" };
    const bad = [
      { page: "host", host: { ...host, title: "t".repeat(201) } },
      { page: "host", host: { ...host, title: "due\nrighe" } },
      { page: "host", host: { ...host, app: "Hub Up" } },
      { page: "dashboard", host },
      { page: "host" },
    ];
    for (const pageContext of bad) {
      const res = await api("POST", `/character-conversations/${id}/messages`, { content: "ciao", pageContext });
      expect(res.status, JSON.stringify(pageContext)).toBe(400);
    }
    const dashboard = await api("POST", `/character-conversations/${id}/messages`, { content: "ciao", pageContext: { page: "dashboard", host } });
    expect(dashboard.json.error).toBe("contesto della pagina non valido");
  });

  it("send_busy_409: turno già in corso", async () => {
    const { id } = await createConv();
    await db.update(characterConversationsTable).set({ turnStatus: "running" }).where(eq(characterConversationsTable.id, id));
    const res = await api("POST", `/character-conversations/${id}/messages`, { content: "ciao" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("il personaggio sta già rispondendo");
    await db.update(characterConversationsTable).set({ turnStatus: "idle" }).where(eq(characterConversationsTable.id, id));
  });

  it("subject_gone_409: l'argomento non esiste più; nel dettaglio subjectGone è true", async () => {
    const { id } = await createConv({ subjectType: "skill", subjectId: "prova" });
    subjectExists = false;
    const res = await api("POST", `/character-conversations/${id}/messages`, { content: "ciao" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("argomento eliminato");
    const detail = await api("GET", `/character-conversations/${id}`);
    expect(detail.json).toMatchObject({ subjectGone: true, subjectTitle: "Skill di prova" });
  });

  it("tetto del personaggio raggiunto → 409 col motivo, nessun messaggio salvato né turno avviato", async () => {
    const { id } = await createConv();
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0" }).where(eq(usersTable.id, userId));
    const res = await api("POST", `/character-conversations/${id}/messages`, { content: "ciao" });
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toMatch(/^Tetto di spesa mensile di Lucius/);
    expect(await db.select().from(characterMessagesTable).where(eq(characterMessagesTable.conversationId, id))).toHaveLength(0);
    const [conv] = await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, id));
    expect(conv!.turnStatus).toBe("idle");
    expect(fake.requests).toHaveLength(0);
  });

  it("conversazione archiviata → 409", async () => {
    const t1 = await api("GET", "/characters/alfred/thread");
    await api("POST", "/characters/alfred/thread/restart");
    const res = await api("POST", `/character-conversations/${t1.json.id}/messages`, { content: "ciao" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("conversazione archiviata");
  });
});

describe("schede e ambiti del token", () => {
  it("token_scopes: api:read solo GET; api:write anche la decisione", async () => {
    const { createApiToken } = await import("../lib/api-tokens");
    const read = (await createApiToken(userId, "r", 30, ["api:read"])).token;
    const write = (await createApiToken(userId, "w", 30, ["api:write"])).token;
    const { id } = await createConv();
    expect((await api("GET", "/character-conversations?character=lucius", undefined, read)).status).toBe(200);
    expect((await api("GET", `/character-conversations/${id}`, undefined, read)).status).toBe(200);
    for (const [m, p, b] of [
      ["POST", "/character-conversations", { character: "lucius", subjectType: "area_agents" }],
      ["PATCH", `/character-conversations/${id}`, { title: "x" }],
      ["POST", `/character-conversations/${id}/messages`, { content: "ciao" }],
      ["POST", "/character-proposals/1/decision", { action: "reject" }],
      ["DELETE", `/character-conversations/${id}`, undefined],
    ] as const) {
      const r = await api(m, p, b, read);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    const [msg] = await db.insert(characterMessagesTable).values({ conversationId: id, role: "assistant", content: "ok" }).returning();
    const [prop] = await db.insert(characterProposalsTable).values({ conversationId: id, messageId: msg!.id, kind: "handoff", payload: { to: "alfred" }, rationale: "" }).returning();
    const dec = await api("POST", `/character-proposals/${prop!.id}/decision`, { action: "accept" }, write);
    expect(dec.status, dec.text).toBe(200);
    expect(dec.json).toMatchObject({ id: prop!.id, kind: "handoff", status: "accepted", payload: { to: "alfred" } });
    expect(dec.json).not.toHaveProperty("conversationId");
    expect((await api("POST", `/character-proposals/${prop!.id}/decision`, { action: "accept" }, write)).status).toBe(409);
    const detail = await api("GET", `/character-conversations/${id}`);
    expect(detail.json.proposals).toHaveLength(1);
  });
});

describe("limite dei messaggi", () => {
  it("send_rate_limited_429: l'11° messaggio in un minuto", async () => {
    fake.chatReply = () => ({ content: "ok", toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const { id } = await createConv();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await api("POST", `/character-conversations/${id}/messages`, { content: `m${i}` })).status);
      if (statuses[i] === 202) await waitIdle(id);
    }
    // I test precedenti hanno già consumato parte del limite: almeno il primo passa, poi arriva il 429
    expect(statuses[0]).toBe(202);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 202 || s === 429)).toBe(true);
  });
});
