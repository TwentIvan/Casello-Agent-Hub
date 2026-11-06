import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamChatProposalsTable,
  teamInstanceSkillsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";

// Route della chat di squadra e scarico delle istruzioni, su un'app Express vera senza login (AUTH_DISABLED=true).
// I turni girano in background: afterEach li attende. Il limite dei messaggi è di 10/min per utente: i test sotto
// ne inviano meno di 10 in tutto, tranne quello dedicato al 429 (che viene per ultimo).

const ACCOUNT_KEY = "sk-CHIAVE-TEAM-CHAT";
const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let modelId: number;
let instanceId: number;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, headers: res.headers };
}

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const instructions = (key: string) => `---\nname: ${key}\ndescription: fa cose\n---\n# Ruolo ${key}\n`;

async function newInstance(name = "Squadra Èsempio!") {
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: `hub-${Math.random().toString(36).slice(2, 8)}`, baseUrl: "https://a.example.com" }).returning();
  const created = await api("POST", "/team-instances", {
    name,
    ref: { appId: app!.id, type: "wi", id: "1" },
    roles: [
      { key: "capo", name: "Capo", task: "identità del capo", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [], localSkills: [] },
      { key: "dev", name: "Dev", task: "", isLead: false, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [], localSkills: [] },
    ],
  });
  expect(created.status, created.text).toBe(201);
  return created.json.id as number;
}

async function createConv(extra: Record<string, unknown> = {}, id = instanceId) {
  const res = await api("POST", `/team-instances/${id}/team-chat-conversations`, { aiModelId: modelId, ...extra });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number };
}

async function waitIdle(id: number) {
  for (let i = 0; i < 200; i++) {
    const res = await api("GET", `/team-chat-conversations/${id}`);
    if (res.json?.turnStatus === "idle") return res.json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("turno non terminato");
}

async function insertProposal(conversationId: number, over: Partial<typeof teamChatProposalsTable.$inferInsert> = {}) {
  const [msg] = await db.insert(teamChatMessagesTable).values({ conversationId, role: "assistant", content: "ok" }).returning();
  const [p] = await db
    .insert(teamChatProposalsTable)
    .values({ conversationId, messageId: msg!.id, kind: "role_identity", roleKey: "dev", payload: { text: "Nuova identità" }, rationale: "serve", targetHash: sha(""), ...over })
    .returning();
  return p!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  restoreLoopback = allowTestLoopback();
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  restoreLoopback();
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  fake = await startFakeProvider({ apiKey: ACCOUNT_KEY });
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(ACCOUNT_KEY), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" }).returning();
  modelId = model!.id;
  instanceId = await newInstance();
});

afterEach(async () => {
  for (let i = 0; i < 200; i++) {
    const running = await db.select({ id: teamChatConversationsTable.id }).from(teamChatConversationsTable).where(eq(teamChatConversationsTable.turnStatus, "running"));
    if (!running.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await fake.close();
});

describe("conversazioni", () => {
  it("crea, elenca, legge ed elimina; mai userId nella risposta", async () => {
    const created = await api("POST", `/team-instances/${instanceId}/team-chat-conversations`, { aiModelId: modelId });
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ teamInstanceId: instanceId, aiModelId: modelId, turnStatus: "idle", tokensUsed: 0, costUsd: null });
    expect(created.json).not.toHaveProperty("userId");
    const list = await api("GET", `/team-instances/${instanceId}/team-chat-conversations`);
    expect(list.json.map((c: { id: number }) => c.id)).toEqual([created.json.id]);
    const detail = await api("GET", `/team-chat-conversations/${created.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ id: created.json.id, messages: [], proposals: [] });
    expect((await api("DELETE", `/team-chat-conversations/${created.json.id}`)).status).toBe(204);
    expect((await api("GET", `/team-chat-conversations/${created.json.id}`)).status).toBe(404);
    expect((await api("DELETE", `/team-chat-conversations/${created.json.id}`)).status).toBe(404);
  });

  it("senza aiModelId usa il modello predefinito; senza predefinito nasce senza modello", async () => {
    const none = await api("POST", `/team-instances/${instanceId}/team-chat-conversations`, {});
    expect(none.status, none.text).toBe(201);
    expect(none.json.aiModelId).toBeNull();
    await db.update(usersTable).set({ defaultAiModelId: modelId }).where(eq(usersTable.id, userId));
    const def = await api("POST", `/team-instances/${instanceId}/team-chat-conversations`, { aiModelId: null });
    expect(def.json.aiModelId).toBe(modelId);
  });

  it("modello di un altro utente → 400; squadra inesistente → 404; corpo non valido → 400", async () => {
    const [stranger] = await db.insert(usersTable).values({ email: "altro@x.it" }).returning();
    const [acc] = await db
      .insert(aiAccountsTable)
      .values({ userId: stranger!.id, name: "Altrui", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("k"), status: "ok" })
      .returning();
    const [m] = await db.insert(aiModelsTable).values({ accountId: acc!.id, modelId: "x", displayName: "X" }).returning();
    const res = await api("POST", `/team-instances/${instanceId}/team-chat-conversations`, { aiModelId: m!.id });
    expect(res.status).toBe(400);
    expect(typeof res.json.error).toBe("string");
    expect((await api("POST", `/team-instances/9999/team-chat-conversations`, { aiModelId: modelId })).status).toBe(404);
    expect((await api("GET", `/team-instances/9999/team-chat-conversations`)).status).toBe(404);
    expect((await api("POST", `/team-instances/${instanceId}/team-chat-conversations`, { aiModelId: "x" })).status).toBe(400);
  });

  it("le conversazioni di un altro utente sono 404 (lettura, eliminazione, messaggio, decisione) e non compaiono in elenco", async () => {
    const [stranger] = await db.insert(usersTable).values({ email: "altro@x.it" }).returning();
    const [conv] = await db.insert(teamChatConversationsTable).values({ teamInstanceId: instanceId, userId: stranger!.id, aiModelId: null, title: "" }).returning();
    const p = await insertProposal(conv!.id);
    expect((await api("GET", `/team-chat-conversations/${conv!.id}`)).status).toBe(404);
    expect((await api("DELETE", `/team-chat-conversations/${conv!.id}`)).status).toBe(404);
    expect((await api("POST", `/team-chat-conversations/${conv!.id}/messages`, { content: "ciao" })).status).toBe(404);
    const dec = await api("POST", `/team-chat-proposals/${p.id}/decision`, { action: "accept" });
    expect(dec.status).toBe(404);
    expect((await api("GET", `/team-instances/${instanceId}/team-chat-conversations`)).json).toEqual([]);
  });
});

describe("messaggi", () => {
  it("202, turno in background, risposta di Lucius", async () => {
    const { id } = await createConv();
    fake.chatReply = () => ({ content: "Ciao, sono Lucius.", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    const res = await api("POST", `/team-chat-conversations/${id}/messages`, { content: "  come va?  " });
    expect(res.status, res.text).toBe(202);
    expect(res.json).toMatchObject({ role: "user", content: "come va?" });
    expect(res.json).not.toHaveProperty("tokens");
    const detail = await waitIdle(id);
    expect(detail.title).toBe("come va?");
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1].content).toBe("Ciao, sono Lucius.");
    expect(detail.tokensUsed).toBe(110);
  });

  it("vuoto, solo spazi, troppo lungo → 400", async () => {
    const { id } = await createConv();
    expect((await api("POST", `/team-chat-conversations/${id}/messages`, { content: "" })).status).toBe(400);
    const blank = await api("POST", `/team-chat-conversations/${id}/messages`, { content: "   " });
    expect(blank.status).toBe(400);
    expect((await api("POST", `/team-chat-conversations/${id}/messages`, { content: "a".repeat(8001) })).status).toBe(400);
  });

  it("turno in corso → 409; conversazione inesistente → 404", async () => {
    const { id } = await createConv();
    await db.update(teamChatConversationsTable).set({ turnStatus: "running" }).where(eq(teamChatConversationsTable.id, id));
    const res = await api("POST", `/team-chat-conversations/${id}/messages`, { content: "ciao" });
    expect(res.status).toBe(409);
    expect(typeof res.json.error).toBe("string");
    await db.update(teamChatConversationsTable).set({ turnStatus: "idle" }).where(eq(teamChatConversationsTable.id, id));
    expect((await api("POST", `/team-chat-conversations/9999/messages`, { content: "ciao" })).status).toBe(404);
  });

  it("tetto di spesa raggiunto → 409 col motivo, nessun messaggio salvato", async () => {
    const { id } = await createConv();
    await db.update(usersTable).set({ monthlyBudgetUsd: "0.000001" }).where(eq(usersTable.id, userId));
    await db.update(teamChatConversationsTable).set({ costUsd: "1", tokensUsed: 10 }).where(eq(teamChatConversationsTable.id, id));
    // la spesa dell'utente conta anche le chat di squadra con il modello dei suoi account
    await db.update(aiModelsTable).set({ priceInputPerMtok: "1", priceOutputPerMtok: "1" }).where(eq(aiModelsTable.id, modelId));
    const res = await api("POST", `/team-chat-conversations/${id}/messages`, { content: "ciao" });
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toMatch(/tetto/i);
    expect(await db.select().from(teamChatMessagesTable)).toHaveLength(0);
  });

  it("squadra chiusa → 409 «squadra chiusa»", async () => {
    const { id } = await createConv();
    expect((await api("POST", `/team-instances/${instanceId}/close`)).status).toBe(200);
    const res = await api("POST", `/team-chat-conversations/${id}/messages`, { content: "ciao" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("squadra chiusa");
    expect(await db.select().from(teamChatMessagesTable)).toHaveLength(0);
  });
});

describe("decisione sulle schede", () => {
  it("accetta: applica l'identità alla squadra e risponde con la scheda", async () => {
    const { id } = await createConv();
    const p = await insertProposal(id);
    const res = await api("POST", `/team-chat-proposals/${p.id}/decision`, { action: "accept" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ id: p.id, status: "accepted", currentValue: "Nuova identità", kind: "role_identity", roleKey: "dev" });
    const inst = await api("GET", `/team-instances/${instanceId}`);
    expect(inst.json.roles.find((r: { key: string }) => r.key === "dev").task).toBe("Nuova identità");
    expect((await api("POST", `/team-chat-proposals/${p.id}/decision`, { action: "reject" })).status).toBe(409);
  });

  it("rifiuta; azione non valida 400; scheda inesistente 404", async () => {
    const { id } = await createConv();
    const p = await insertProposal(id);
    expect((await api("POST", `/team-chat-proposals/${p.id}/decision`, { action: "boh" })).status).toBe(400);
    const res = await api("POST", `/team-chat-proposals/${p.id}/decision`, { action: "reject" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("rejected");
    expect(res.json.currentValue).toBe("");
    expect((await api("POST", `/team-chat-proposals/9999/decision`, { action: "accept" })).status).toBe(404);
  });

  it("valore cambiato dopo la proposta → 409 e scheda stale; squadra chiusa → 409", async () => {
    const { id } = await createConv();
    const stale = await insertProposal(id, { targetHash: "deadbeef" });
    const res = await api("POST", `/team-chat-proposals/${stale.id}/decision`, { action: "accept" });
    expect(res.status).toBe(409);
    const detail = await api("GET", `/team-chat-conversations/${id}`);
    expect(detail.json.proposals.find((x: { id: number }) => x.id === stale.id).status).toBe("stale");
    const p2 = await insertProposal(id);
    await api("POST", `/team-instances/${instanceId}/close`);
    const closed = await api("POST", `/team-chat-proposals/${p2.id}/decision`, { action: "accept" });
    expect(closed.status).toBe(409);
    expect(closed.json.error).toBe("squadra chiusa");
  });

  it("GET conversazione porta currentValue di identità e istruzioni", async () => {
    const { id } = await createConv();
    await insertProposal(id, { roleKey: "capo", targetHash: sha("identità del capo") });
    await insertProposal(id, { kind: "role_instructions", roleKey: "capo", payload: { markdown: instructions("capo") } });
    const detail = await api("GET", `/team-chat-conversations/${id}`);
    const [a, b] = detail.json.proposals;
    expect(a.currentValue).toBe("identità del capo");
    expect(b.currentValue).toBe("");
    expect(a).not.toHaveProperty("targetHash");
  });
});

describe("scarichi", () => {
  async function addInstructions(key: string) {
    await db.insert(teamInstanceSkillsTable).values({ instanceId, code: `ruolo-${key}`, name: `Istruzioni ${key}`, kind: "casello", content: instructions(key) });
  }

  it("istruzioni di un ruolo: markdown in allegato; senza istruzioni 404", async () => {
    await addInstructions("dev");
    const res = await fetch(`${base}/api/team-instances/${instanceId}/roles/dev/instructions.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="dev.md"');
    expect(await res.text()).toBe(instructions("dev"));
    const none = await api("GET", `/team-instances/${instanceId}/roles/capo/instructions.md`);
    expect(none.status).toBe(404);
    expect(none.json.error).toBe("il ruolo non ha istruzioni");
    expect((await api("GET", `/team-instances/9999/roles/dev/instructions.md`)).status).toBe(404);
  });

  it("zip: un file per ruolo con istruzioni, nome dalla squadra; nessuno → 404", async () => {
    expect((await api("GET", `/team-instances/${instanceId}/roles-export.zip`)).status).toBe(404);
    await addInstructions("dev");
    await addInstructions("capo");
    const res = await fetch(`${base}/api/team-instances/${instanceId}/roles-export.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="squadra-esempio-ruoli.zip"');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(buf.includes(Buffer.from("capo.md"))).toBe(true);
    expect(buf.includes(Buffer.from("dev.md"))).toBe(true);
    expect(buf.includes(Buffer.from(instructions("dev")))).toBe(true);
  });
});

describe("limite", () => {
  it("l'11° messaggio in un minuto → 429", async () => {
    const { id } = await createConv();
    await db.update(teamChatConversationsTable).set({ turnStatus: "running" }).where(eq(teamChatConversationsTable.id, id));
    // turno «in corso»: ogni invio consuma comunque il contatore e risponde 409 finché non scatta il limite
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await api("POST", `/team-chat-conversations/${id}/messages`, { content: "x" })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    await db.update(teamChatConversationsTable).set({ turnStatus: "idle" }).where(eq(teamChatConversationsTable.id, id));
  });
});
