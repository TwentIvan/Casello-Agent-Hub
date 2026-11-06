import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  characterConversationsTable,
  characterMessagesTable,
  characterNotesTable,
  characterProposalsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { INTERRUPTED_TURN_MESSAGE } from "../plan-chat/run-turn";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { createConversation } from "./conversations";
import { createTurnContext, recordProposal } from "./proposals";
import { registerSubject } from "./registry";
import { TurnBusyError, failInterruptedCharacterTurns, startCharacterTurn } from "./run-turn";
import { CHARACTER_MESSAGES, CharacterError, toolOk, type SubjectHandler } from "./types";

const ACCOUNT_KEY = "sk-CHIAVE-DEI-PERSONAGGI";

let fake: FakeProvider;
let restoreLoopback: () => void;
let unregister: () => void;
let userId: number;
let modelId: number;
let conversationId: number;
// L'argomento finto esiste finché questo flag è vero
let subjectExists = true;
let lastPage: unknown = "non chiamato";
const savedKey = process.env["CASELLO_SECRET_KEY"];

const fakeSubject: SubjectHandler = {
  character: "lucius",
  type: "skill",
  resolve: async (_userId, subjectId) => (subjectExists && subjectId === "prova" ? { title: "Skill di prova" } : null),
  context: async (_userId, _subjectId, page) => {
    lastPage = page;
    return ["Skill prova: contenuto DATO-DELL-ARGOMENTO"];
  },
  tools: [{ type: "function", function: { name: "leggi_prova", description: "Legge", parameters: { type: "object", properties: {} } } }],
  runTool: async () => toolOk("letto"),
};

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  unregister = registerSubject(fakeSubject);
});
afterAll(async () => {
  unregister();
  restoreLoopback();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE ai_accounts, users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  subjectExists = true;
  lastPage = "non chiamato";
  fake = await startFakeProvider({ apiKey: ACCOUNT_KEY });
  await pool.query("TRUNCATE ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "a@x.it" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(ACCOUNT_KEY), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
  await db.update(usersTable).set({ luciusAiModelId: modelId }).where(eq(usersTable.id, userId));
  const conv = await createConversation(userId, "lucius", "skill", "prova");
  conversationId = conv.id;
});

afterEach(async () => {
  await waitIdle(conversationId);
  await fake.close();
});

async function waitIdle(id: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [c] = await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, id));
    if (!c || c.turnStatus === "idle") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("turno non terminato");
}

const getConv = async () => (await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, conversationId)))[0]!;
const getMessages = () =>
  db.select().from(characterMessagesTable).where(eq(characterMessagesTable.conversationId, conversationId)).orderBy(characterMessagesTable.id);
const chatBodies = () =>
  fake.requests
    .filter((r) => r.path.includes("chat/completions"))
    .map((r) => r.body as { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> });

describe("conversazioni dei personaggi", () => {
  it("createConversation: modello del personaggio, titolo dell'argomento; argomento non risolvibile → 404", async () => {
    const conv = await getConv();
    expect(conv).toMatchObject({ character: "lucius", subjectType: "skill", subjectId: "prova", subjectTitle: "Skill di prova", aiModelId: modelId });
    await expect(createConversation(userId, "lucius", "skill", "altra")).rejects.toMatchObject({ status: 404, message: "argomento non trovato" });
    // Argomento di un altro personaggio
    await expect(createConversation(userId, "alfred", "skill", "prova")).rejects.toMatchObject({ status: 404 });
  });

  it("one_turn_at_a_time: un secondo turno mentre il primo è in corso → TurnBusyError", async () => {
    fake.delayMs = 200;
    fake.chatReply = { content: "Risposta", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    await startCharacterTurn(conversationId, "Primo", null);
    await expect(startCharacterTurn(conversationId, "Secondo", null)).rejects.toBeInstanceOf(TurnBusyError);
    await waitIdle(conversationId);
    const messages = await getMessages();
    expect(messages.map((m) => m.content)).toEqual(["Primo", "Risposta"]);
  });

  it("page_context_saved_and_given_as_data: pagina sul messaggio utente e in un messaggio user, non nel prompt di sistema", async () => {
    fake.chatReply = { content: "Ok", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const userMessage = await startCharacterTurn(conversationId, "Che ne pensi?", { page: "skill", id: "prova" });
    expect(userMessage.pageContext).toEqual({ page: "skill", id: "prova" });
    await waitIdle(conversationId);
    expect(lastPage).toEqual({ page: "skill", id: "prova" });
    const body = chatBodies()[0]!;
    const system = body.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n");
    expect(system).not.toContain("Pagina da cui scrive");
    expect(system).not.toContain("DATO-DELL-ARGOMENTO");
    const pageMsg = body.messages.find((m) => m.role === "user" && (m.content ?? "").includes("Pagina da cui scrive l'utente (dato)"));
    expect(pageMsg?.content).toContain("skill prova");
    expect(body.messages.some((m) => m.role === "user" && (m.content ?? "").includes("DATO-DELL-ARGOMENTO"))).toBe(true);
    expect(body.messages.at(-1)).toMatchObject({ role: "user", content: "Che ne pensi?" });
    expect(body.tools?.map((t) => t.function.name)).toEqual(expect.arrayContaining(["leggi_prova", "ricorda", "cerca_nello_storico", "passa_a"]));
    // Titolo dal primo messaggio
    expect((await getConv()).title).toBe("Che ne pensi?");
  });

  it("memory_block_in_context: gli appunti di Lucius arrivano come dati", async () => {
    await db.insert(characterNotesTable).values({ userId, character: "lucius", content: "Preferisce SAP" });
    await db.insert(characterNotesTable).values({ userId, character: "alfred", content: "Appunto di Alfred" });
    fake.chatReply = { content: "Ok", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    await startCharacterTurn(conversationId, "Ciao", null);
    await waitIdle(conversationId);
    const body = chatBodies()[0]!;
    const memory = body.messages.find((m) => m.role === "user" && (m.content ?? "").includes("Memoria di Lucius"));
    expect(memory?.content).toContain("Preferisce SAP");
    expect(JSON.stringify(body.messages)).not.toContain("Appunto di Alfred");
    expect(body.messages.find((m) => m.role === "system")?.content).not.toContain("Preferisce SAP");
  });

  it("cost_and_tokens_accumulated: token e costo cumulati sulla conversazione", async () => {
    fake.chatReply = { content: "Uno", toolCalls: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } };
    await startCharacterTurn(conversationId, "Primo", null);
    await waitIdle(conversationId);
    let conv = await getConv();
    expect(conv.tokensUsed).toBe(1_000_000);
    expect(Number(conv.costUsd)).toBeCloseTo(1, 6);
    fake.chatReply = { content: "Due", toolCalls: [], usage: { prompt_tokens: 0, completion_tokens: 500_000 } };
    await startCharacterTurn(conversationId, "Secondo", null);
    await waitIdle(conversationId);
    conv = await getConv();
    expect(conv.tokensUsed).toBe(1_500_000);
    expect(Number(conv.costUsd)).toBeCloseTo(2, 6);
    const messages = await getMessages();
    expect(messages.map((m) => m.tokens)).toEqual([0, 1_000_000, 0, 500_000]);
  });

  it("budget_block_closes_turn_with_error: tetto del personaggio raggiunto, nessuna chiamata al modello", async () => {
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0" }).where(eq(usersTable.id, userId));
    await startCharacterTurn(conversationId, "Ciao", null);
    await waitIdle(conversationId);
    const messages = await getMessages();
    expect(messages[1]).toMatchObject({ role: "assistant", error: true });
    expect(messages[1]!.content).toContain("Tetto di spesa mensile di Lucius raggiunto");
    expect(chatBodies()).toHaveLength(0);
  });

  it("no_model_message: conversazione senza modello → messaggio d'errore", async () => {
    await db.update(characterConversationsTable).set({ aiModelId: null }).where(eq(characterConversationsTable.id, conversationId));
    await startCharacterTurn(conversationId, "Ciao", null);
    await waitIdle(conversationId);
    const messages = await getMessages();
    expect(messages[1]).toMatchObject({ role: "assistant", error: true, content: CHARACTER_MESSAGES.noModel });
    expect(chatBodies()).toHaveLength(0);
  });

  it("interrupted_on_restart: i turni running si chiudono con INTERRUPTED_TURN_MESSAGE", async () => {
    await db.update(characterConversationsTable).set({ turnStatus: "running" }).where(eq(characterConversationsTable.id, conversationId));
    await db.insert(characterMessagesTable).values({ conversationId, role: "user", content: "Ciao" });
    await db.insert(characterMessagesTable).values({ conversationId, role: "assistant", content: "" });
    expect(await failInterruptedCharacterTurns()).toBe(1);
    expect((await getConv()).turnStatus).toBe("idle");
    const messages = await getMessages();
    expect(messages[1]).toMatchObject({ role: "assistant", content: INTERRUPTED_TURN_MESSAGE, error: true });
    expect(await failInterruptedCharacterTurns()).toBe(0);
  });

  it("max_ten_proposals_per_turn: l'11ª scheda → «troppe schede in questo turno»", async () => {
    const [msg] = await db.insert(characterMessagesTable).values({ conversationId, role: "assistant", content: "" }).returning();
    const ctx = createTurnContext({ userId, conversationId, messageId: msg!.id, subjectId: "prova" });
    for (let i = 0; i < 10; i++) {
      const r = await recordProposal(ctx, "skill_content", { content: `v${i}` }, "motivo", "hash");
      expect(r).toHaveProperty("id");
    }
    expect(ctx.proposalsLeft()).toBe(0);
    expect(await recordProposal(ctx, "skill_content", { content: "v10" }, "motivo", "hash")).toEqual({ error: "troppe schede in questo turno" });
    const rows = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.messageId, msg!.id));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ kind: "skill_content", status: "pending", targetHash: "hash", rationale: "motivo" });
  });

  it("subject_gone_409: argomento sparito → 409 «argomento eliminato», nessun messaggio", async () => {
    subjectExists = false;
    const err = await startCharacterTurn(conversationId, "Ciao", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CharacterError);
    expect(err).toMatchObject({ status: 409, message: "argomento eliminato" });
    expect(await getMessages()).toHaveLength(0);
    expect((await getConv()).turnStatus).toBe("idle");
  });

  it("messaggio vuoto o troppo lungo → 400", async () => {
    await expect(startCharacterTurn(conversationId, "   ", null)).rejects.toMatchObject({ status: 400, message: "messaggio vuoto" });
    await expect(startCharacterTurn(conversationId, "x".repeat(8_001), null)).rejects.toMatchObject({ status: 400 });
  });
});
