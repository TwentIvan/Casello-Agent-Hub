import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  analysisItemsTable,
  appsTable,
  planConversationsTable,
  planMessagesTable,
  planProposalsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";

// Route della chat del piano su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true: l'utente
// è dev@localhost) e con un finto provider AI dietro il modello della conversazione. I test che avviano un
// turno lo attendono: nulla gira in background oltre il test (afterEach). Il rate limit dei messaggi è di
// 10 al minuto per utente e il contatore vive quanto il processo: questo file ne invia meno di 10.

const ACCOUNT_KEY = "sk-CHIAVE-DELLA-CHAT";
const MODEL_UNAVAILABLE = "Il modello non è più disponibile: scegline un altro";

let base: string;
let server: http.Server;
let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let appId: number;
let analysisId: number;
let accountId: number;
let modelId: number;
const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

async function api(method: string, path: string, body?: unknown, root = base) {
  const res = await fetch(`${root}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

const completion = (key: string, title = "Aggiungere gli ordini") => ({
  key,
  phase: 1,
  area: "api",
  title,
  missing: "manca",
  evidence: [],
  goal: "obiettivo",
  dependsOn: [],
  files: [],
  effort: "S",
  doneWhen: "fatto",
  implementation: "come",
});

const newAnalysis = async (status: "completed" | "failed" = "completed", forApp = appId) =>
  (
    await db
      .insert(analysesTable)
      .values({ appId: forApp, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status })
      .returning()
  )[0]!;

async function createConv(extra: Record<string, unknown> = {}) {
  const res = await api("POST", `/apps/${appId}/plan-conversations`, { aiModelId: modelId, ...extra });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number };
}

async function waitIdleApi(id: number) {
  for (let i = 0; i < 200; i++) {
    const res = await api("GET", `/plan-conversations/${id}`);
    if (res.json?.turnStatus === "idle") return res.json;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("turno non terminato");
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
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  fake = await startFakeProvider({ apiKey: ACCOUNT_KEY });
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning();
  userId = user!.id;
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example" }).returning();
  appId = app!.id;
  analysisId = (await newAnalysis()).id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(ACCOUNT_KEY), status: "ok" })
    .returning();
  accountId = account!.id;
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
});

afterEach(async () => {
  for (let i = 0; i < 200; i++) {
    const running = await db
      .select({ id: planConversationsTable.id })
      .from(planConversationsTable)
      .where(eq(planConversationsTable.turnStatus, "running"));
    if (!running.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await fake.close();
});

describe("route della chat del piano", () => {
  it("crea una conversazione sull'ultima analisi completata", async () => {
    await newAnalysis("failed");
    const latest = await newAnalysis("completed");
    const res = await api("POST", `/apps/${appId}/plan-conversations`, { aiModelId: modelId });
    expect(res.status, res.text).toBe(201);
    expect(res.json).toMatchObject({ appId, analysisId: latest.id, aiModelId: modelId, turnStatus: "idle", tokensUsed: 0 });
    expect(res.json).not.toHaveProperty("userId");
    const list = await api("GET", `/apps/${appId}/plan-conversations`);
    expect(list.status).toBe(200);
    expect(list.json.map((c: { id: number }) => c.id)).toEqual([res.json.id]);
  });

  it("senza analisi completata → 409", async () => {
    await pool.query("DELETE FROM analyses");
    await newAnalysis("failed");
    const res = await api("POST", `/apps/${appId}/plan-conversations`, { aiModelId: modelId });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("L'app non ha un'analisi completata");
  });

  it("analisi di un'altra app o app inesistente → 404", async () => {
    const [other] = await db.insert(appsTable).values({ name: "Altra", slug: "altra", baseUrl: "https://altra.example" }).returning();
    const foreign = await newAnalysis("completed", other!.id);
    expect((await api("POST", `/apps/${appId}/plan-conversations`, { aiModelId: modelId, analysisId: foreign.id })).status).toBe(404);
    expect((await api("POST", `/apps/99999/plan-conversations`, { aiModelId: modelId })).status).toBe(404);
  });

  it("modello non selezionabile → 400", async () => {
    const [stranger] = await db.insert(usersTable).values({ email: "altro@x.it" }).returning();
    const [acc] = await db
      .insert(aiAccountsTable)
      .values({ userId: stranger!.id, name: "Altrui", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("k"), status: "ok" })
      .returning();
    const [m] = await db.insert(aiModelsTable).values({ accountId: acc!.id, modelId: "x", displayName: "X" }).returning();
    const res = await api("POST", `/apps/${appId}/plan-conversations`, { aiModelId: m!.id });
    expect(res.status).toBe(400);
    expect(typeof res.json.error).toBe("string");
  });

  it("un messaggio avvia il turno e la conversazione mostra risposta e proposta", async () => {
    const { id } = await createConv();
    let n = 0;
    fake.chatReply = () => {
      n += 1;
      return n === 1
        ? {
            content: null,
            toolCalls: [{ id: "c1", name: "propose", arguments: JSON.stringify({ kind: "add", chapter: "completion", payload: completion("k1"), rationale: "serve" }) }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }
        : { content: "Ho proposto una voce.", toolCalls: [], usage: { prompt_tokens: 120, completion_tokens: 10 } };
    };
    const sent = await api("POST", `/plan-conversations/${id}/messages`, { content: "Aggiungi gli ordini" });
    expect(sent.status, sent.text).toBe(202);
    expect(sent.json).toMatchObject({ role: "user", content: "Aggiungi gli ordini", error: false });

    const conv = await waitIdleApi(id);
    expect(conv).toMatchObject({ id, title: "Aggiungi gli ordini", tokensUsed: 250, newerAnalysisId: null });
    expect(conv.costUsd).toBeGreaterThan(0);
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.messages[1]).toMatchObject({ content: "Ho proposto una voce.", error: false });
    expect(conv.proposals).toHaveLength(1);
    expect(conv.proposals[0]).toMatchObject({
      messageId: conv.messages[1].id,
      kind: "add",
      chapter: "completion",
      title: "Aggiungere gli ordini",
      status: "pending",
      itemId: null,
      decidedAt: null,
    });
  });

  it("newerAnalysisId segnala un'analisi completata più recente", async () => {
    const { id } = await createConv();
    const newer = await newAnalysis("completed");
    const res = await api("GET", `/plan-conversations/${id}`);
    expect(res.json.newerAnalysisId).toBe(newer.id);
  });

  it("due messaggi simultanei: uno 202, l'altro 409", async () => {
    const { id } = await createConv();
    fake.delayMs = 150;
    const [a, b] = await Promise.all([
      api("POST", `/plan-conversations/${id}/messages`, { content: "uno" }),
      api("POST", `/plan-conversations/${id}/messages`, { content: "due" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect([a, b].find((r) => r.status === 409)!.json.error).toBe("Il bot sta già rispondendo");
    await waitIdleApi(id);
  });

  it("il messaggio e il titolo usano il testo senza spazi ai bordi", async () => {
    const { id } = await createConv();
    fake.chatReply = () => ({ content: "ok", toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const sent = await api("POST", `/plan-conversations/${id}/messages`, { content: "  ciao bot \n" });
    expect(sent.status, sent.text).toBe(202);
    expect(sent.json.content).toBe("ciao bot");
    expect((await waitIdleApi(id)).title).toBe("ciao bot");
  });

  it("messaggio vuoto o oltre 8 000 caratteri → 400", async () => {
    const { id } = await createConv();
    expect((await api("POST", `/plan-conversations/${id}/messages`, { content: "" })).status).toBe(400);
    expect((await api("POST", `/plan-conversations/${id}/messages`, { content: "  \n\t " })).status).toBe(400);
    expect((await api("POST", `/plan-conversations/${id}/messages`, { content: "x".repeat(8001) })).status).toBe(400);
    expect((await api("GET", `/plan-conversations/${id}`)).json.messages).toEqual([]);
  });

  it("modello ritirato → 409 e, dopo il PATCH con un altro modello, il messaggio passa", async () => {
    const { id } = await createConv();
    await db.update(aiModelsTable).set({ availability: "unavailable" }).where(eq(aiModelsTable.id, modelId));
    const blocked = await api("POST", `/plan-conversations/${id}/messages`, { content: "ciao" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe(MODEL_UNAVAILABLE);

    const [other] = await db.insert(aiModelsTable).values({ accountId, modelId: "fake-2", displayName: "Fake 2" }).returning();
    const patched = await api("PATCH", `/plan-conversations/${id}`, { aiModelId: other!.id });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.json.aiModelId).toBe(other!.id);
    const ok = await api("POST", `/plan-conversations/${id}/messages`, { content: "ciao" });
    expect(ok.status, ok.text).toBe(202);
    await waitIdleApi(id);
  });

  it("PATCH con un turno in corso → 409", async () => {
    const { id } = await createConv();
    await db.update(planConversationsTable).set({ turnStatus: "running" }).where(eq(planConversationsTable.id, id));
    const res = await api("PATCH", `/plan-conversations/${id}`, { aiModelId: modelId });
    expect(res.status).toBe(409);
    await db.update(planConversationsTable).set({ turnStatus: "idle" }).where(eq(planConversationsTable.id, id));
  });

  it("decisione accept → 200 con la voce; seconda decisione → 409", async () => {
    const { id } = await createConv();
    const [msg] = await db.insert(planMessagesTable).values({ conversationId: id, role: "assistant", content: "ecco" }).returning();
    const [proposal] = await db
      .insert(planProposalsTable)
      .values({ conversationId: id, messageId: msg!.id, kind: "add", chapter: "completion", payload: completion("k1", "Ordini"), rationale: "serve" })
      .returning();
    const res = await api("POST", `/plan-proposals/${proposal!.id}/decision`, { action: "accept" });
    expect(res.status, res.text).toBe(200);
    expect(res.json.proposal).toMatchObject({ id: proposal!.id, status: "accepted", title: "Ordini" });
    expect(res.json.item).toMatchObject({ analysisId, origin: "chat", status: "approved", chapter: "completion" });
    expect(res.json.proposal.itemId).toBe(res.json.item.id);

    const again = await api("POST", `/plan-proposals/${proposal!.id}/decision`, { action: "reject" });
    expect(again.status).toBe(409);
    expect(typeof again.json.error).toBe("string");
    expect((await api("POST", `/plan-proposals/${proposal!.id}/decision`, { action: "boh" })).status).toBe(400);
  });

  it("decisione reject → item nullo; proposta inesistente → 404", async () => {
    const { id } = await createConv();
    const [msg] = await db.insert(planMessagesTable).values({ conversationId: id, role: "assistant", content: "ecco" }).returning();
    const [proposal] = await db
      .insert(planProposalsTable)
      .values({ conversationId: id, messageId: msg!.id, kind: "add", chapter: "completion", payload: completion("k1"), rationale: "r" })
      .returning();
    const res = await api("POST", `/plan-proposals/${proposal!.id}/decision`, { action: "reject" });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ item: null, proposal: { status: "rejected" } });
    expect((await api("POST", `/plan-proposals/99999/decision`, { action: "accept" })).status).toBe(404);
  });

  it("la proposta discard porta il titolo della voce di destinazione", async () => {
    const { id } = await createConv();
    const [item] = await db
      .insert(analysisItemsTable)
      .values({ analysisId, chapter: "completion", ref: "completion:1", position: 0, diff: "new", payload: completion("k", "Titolo bersaglio") })
      .returning();
    const [msg] = await db.insert(planMessagesTable).values({ conversationId: id, role: "assistant", content: "ecco" }).returning();
    await db.insert(planProposalsTable).values({
      conversationId: id,
      messageId: msg!.id,
      kind: "discard",
      chapter: "completion",
      payload: null,
      rationale: "r",
      targetItemId: item!.id,
      targetHash: "h",
    });
    const res = await api("GET", `/plan-conversations/${id}`);
    expect(res.json.proposals[0]).toMatchObject({ kind: "discard", title: "Titolo bersaglio", payload: null, targetItemId: item!.id });
  });

  it("conversazione di un altro utente → 404", async () => {
    const [stranger] = await db.insert(usersTable).values({ email: "altro@x.it" }).returning();
    const [conv] = await db
      .insert(planConversationsTable)
      .values({ appId, analysisId, userId: stranger!.id, aiModelId: modelId, title: "altrui" })
      .returning();
    const [msg] = await db.insert(planMessagesTable).values({ conversationId: conv!.id, role: "assistant", content: "x" }).returning();
    const [proposal] = await db
      .insert(planProposalsTable)
      .values({ conversationId: conv!.id, messageId: msg!.id, kind: "add", chapter: "completion", payload: completion("k"), rationale: "r" })
      .returning();
    const c = conv!.id;
    expect((await api("GET", `/plan-conversations/${c}`)).status).toBe(404);
    expect((await api("PATCH", `/plan-conversations/${c}`, { aiModelId: modelId })).status).toBe(404);
    expect((await api("POST", `/plan-conversations/${c}/messages`, { content: "ciao" })).status).toBe(404);
    expect((await api("DELETE", `/plan-conversations/${c}`)).status).toBe(404);
    expect((await api("POST", `/plan-proposals/${proposal!.id}/decision`, { action: "accept" })).status).toBe(404);
    expect((await api("GET", `/apps/${appId}/plan-conversations`)).json).toEqual([]);
    const [row] = await db.select().from(planProposalsTable).where(eq(planProposalsTable.id, proposal!.id));
    expect(row!.status).toBe("pending");
  });

  it("DELETE conserva le voci accettate con conversation_id nullo", async () => {
    const { id } = await createConv();
    const [item] = await db
      .insert(analysisItemsTable)
      .values({ analysisId, chapter: "completion", ref: "chat-1", position: 0, diff: "new", payload: completion("k"), status: "approved", origin: "chat", conversationId: id })
      .returning();
    const res = await api("DELETE", `/plan-conversations/${id}`);
    expect(res.status).toBe(204);
    expect(await db.select().from(planConversationsTable).where(eq(planConversationsTable.id, id))).toHaveLength(0);
    const [kept] = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.id, item!.id));
    expect(kept).toMatchObject({ origin: "chat", conversationId: null });
  });

  it("GET /apps/:id/plan include le voci da chat delle analisi precedenti", async () => {
    const latest = await newAnalysis("completed");
    const row = { diff: "new" as const, position: 0, payload: completion("k") };
    await db.insert(analysisItemsTable).values([
      { ...row, analysisId: latest.id, chapter: "completion", ref: "completion:1" },
      { ...row, analysisId: latest.id, chapter: "tool", ref: "tool:x", payload: { name: "x" } },
      { ...row, analysisId, chapter: "completion", ref: "chat-1", status: "approved", origin: "chat" },
      { ...row, analysisId, chapter: "completion", ref: "arch-old", status: "approved" },
    ]);
    const res = await api("GET", `/apps/${appId}/plan`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.analysisId).toBe(latest.id);
    expect(res.json.items.map((i: { ref: string }) => i.ref).sort()).toEqual(["chat-1", "completion:1"]);
    expect(res.json.items.find((i: { ref: string }) => i.ref === "chat-1").origin).toBe("chat");

    await pool.query("DELETE FROM analyses");
    const empty = await api("GET", `/apps/${appId}/plan`);
    expect(empty.json).toEqual({
      analysisId: null,
      items: [],
      issues: {
        available: false,
        unavailableReason: "Collega il repository tramite l'App GitHub per creare le issue",
        repo: null,
        open: 0,
        closed: 0,
        approvedWithoutIssue: 0,
        checkedAt: null,
      },
    });
    expect((await api("GET", `/apps/99999/plan`)).status).toBe(404);
  });

  it("GET /analyses/:id espone origin delle voci", async () => {
    await db.insert(analysisItemsTable).values([
      { analysisId, chapter: "completion", ref: "a", position: 0, diff: "new", payload: completion("a") },
      { analysisId, chapter: "completion", ref: "b", position: 1, diff: "new", payload: completion("b"), origin: "chat" },
    ]);
    const res = await api("GET", `/analyses/${analysisId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json.items.map((i: { origin: string }) => i.origin)).toEqual(["architect", "chat"]);
  });

  it("il limite di messaggi al minuto per utente risponde 429", async () => {
    const { createPlanChatRouter } = await import("./plan-chat");
    const { default: express } = await import("express");
    const { errorHandler } = await import("../middlewares/error-handler");
    const { requireAuth } = await import("../lib/auth");
    const app = express();
    app.use(express.json());
    app.use("/api", requireAuth, createPlanChatRouter({ messageLimit: 1 }));
    app.use(errorHandler);
    const small = http.createServer(app);
    const root = `http://127.0.0.1:${await listen(small)}`;
    try {
      const { id } = await createConv();
      expect((await api("POST", `/plan-conversations/${id}/messages`, { content: "uno" }, root)).status).toBe(202);
      await waitIdleApi(id);
      expect((await api("POST", `/plan-conversations/${id}/messages`, { content: "due" }, root)).status).toBe(429);
    } finally {
      small.closeAllConnections?.();
      await new Promise<void>((r) => small.close(() => r()));
    }
  });
});
