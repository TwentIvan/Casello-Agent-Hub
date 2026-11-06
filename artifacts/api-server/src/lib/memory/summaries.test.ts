import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  analysesTable,
  characterConversationsTable,
  characterMessagesTable,
  characterHistoryTable,
  planConversationsTable,
  planMessagesTable,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamInstancesTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { summarizeConversation, sweepSummaries } from "./summaries";
import { MEMORY_MESSAGES } from "./types";
import { userSpend } from "../budget";
import { MEMORY_TOOLS, runMemoryTool } from "./tools";

const KEY = "sk-CHIAVE-RIASSUNTI";
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let appId: number;
let analysisId: number;
let modelId: number;
const savedKey = process.env["CASELLO_SECRET_KEY"];

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(async () => {
  restoreLoopback();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  await pool.end();
});

beforeEach(async () => {
  fake = await startFakeProvider({ apiKey: KEY });
  fake.chatReply = { content: "Decisioni: usare il piano B.", toolCalls: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } };
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "s@x.it" }).returning();
  userId = user!.id;
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "https://x.example" }).returning();
  appId = app!.id;
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
    .returning();
  analysisId = analysis!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
  await db.update(usersTable).set({ defaultAiModelId: modelId }).where(eq(usersTable.id, userId));
});

afterEach(async () => {
  await fake.close();
});

async function planConv(updatedAt: Date, messages: { role: "user" | "assistant"; content: string; error?: boolean }[] = [{ role: "user", content: "Vorrei il piano B" }, { role: "assistant", content: "Ok, piano B" }]) {
  const [c] = await db
    .insert(planConversationsTable)
    .values({ appId, analysisId, userId, aiModelId: modelId, title: "Piano ordini", updatedAt })
    .returning();
  for (const m of messages) await db.insert(planMessagesTable).values({ conversationId: c!.id, ...m });
  return c!.id;
}

const history = () => db.select().from(characterHistoryTable);
const getPlan = async (id: number) => (await db.select().from(planConversationsTable).where(eq(planConversationsTable.id, id)))[0]!;

describe("sweepSummaries", () => {
  it("conversazione ferma da 31 minuti: una voce di storico con costo", async () => {
    const id = await planConv(minutesAgo(31));
    expect(await sweepSummaries()).toBe(1);
    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, character: "lucius", kind: "plan_conversation", refId: id, title: "Piano ordini", tokensUsed: 1200, aiModelId: modelId });
    expect(rows[0]!.summary).toContain("piano B");
    expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.0014, 6);
    expect((await getPlan(id)).summarizedAt).not.toBeNull();
    const body = fake.requests.find((r) => r.path.endsWith("/chat/completions"))!.body as { messages: { content: string }[]; max_tokens?: number };
    expect(body.messages[1]!.content).toBe("Utente: Vorrei il piano B\n\nLucius: Ok, piano B");
  });

  it("ferma da 29 minuti: nulla", async () => {
    const id = await planConv(minutesAgo(29));
    expect(await sweepSummaries()).toBe(0);
    expect(await history()).toHaveLength(0);
    expect((await getPlan(id)).summarizedAt).toBeNull();
  });

  it("turno in corso: saltata senza segnare", async () => {
    const id = await planConv(minutesAgo(40));
    await db.update(planConversationsTable).set({ turnStatus: "running", updatedAt: minutesAgo(40) }).where(eq(planConversationsTable.id, id));
    expect(await sweepSummaries()).toBe(0);
    expect((await getPlan(id)).summarizedAt).toBeNull();
  });

  it("senza modello predefinito: nessuna voce, summarized_at valorizzato", async () => {
    await db.update(usersTable).set({ defaultAiModelId: null }).where(eq(usersTable.id, userId));
    const id = await planConv(minutesAgo(31));
    await sweepSummaries();
    expect(await history()).toHaveLength(0);
    expect((await getPlan(id)).summarizedAt).not.toBeNull();
    // non si ritenta senza novità
    expect(await sweepSummaries()).toBe(0);
  });

  it("senza messaggi: segnata e basta; i messaggi d'errore non entrano nella trascrizione", async () => {
    const empty = await planConv(minutesAgo(31), []);
    await sweepSummaries();
    expect(await history()).toHaveLength(0);
    expect((await getPlan(empty)).summarizedAt).not.toBeNull();
    await planConv(minutesAgo(31), [
      { role: "user", content: "ciao" },
      { role: "assistant", content: "ERRORE", error: true },
    ]);
    await sweepSummaries();
    const bodies = fake.requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => (r.body as { messages: { content: string }[] }).messages[1]!.content);
    expect(bodies).toEqual(["Utente: ciao"]);
  });

  it("un nuovo messaggio dopo il riassunto: il giro successivo aggiorna la stessa voce", async () => {
    const id = await planConv(minutesAgo(31));
    await sweepSummaries();
    fake.chatReply = { content: "Riassunto nuovo", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 10 } };
    await db.insert(planMessagesTable).values({ conversationId: id, role: "user", content: "altro" });
    await db.update(planConversationsTable).set({ updatedAt: minutesAgo(31) }).where(eq(planConversationsTable.id, id));
    // summarized_at è "adesso", quindi più recente di updated_at: serve un aggiornamento dopo
    await db.update(planConversationsTable).set({ summarizedAt: minutesAgo(60) }).where(eq(planConversationsTable.id, id));
    expect(await sweepSummaries()).toBe(1);
    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("Riassunto nuovo");
  });

  it("chat di squadra: voce team_chat", async () => {
    const [team] = await db
      .insert(teamInstancesTable)
      .values({ name: "Squadra", refAppId: appId, refType: "wi", refId: "1", refTitle: "WI 1" })
      .returning();
    const [c] = await db
      .insert(teamChatConversationsTable)
      .values({ teamInstanceId: team!.id, userId, aiModelId: modelId, title: "Ruoli", updatedAt: minutesAgo(40) })
      .returning();
    await db.insert(teamChatMessagesTable).values({ conversationId: c!.id, role: "user", content: "cambia il capo" });
    expect(await sweepSummaries()).toBe(1);
    const rows = await history();
    expect(rows[0]).toMatchObject({ kind: "team_chat", refId: c!.id, title: "Ruoli" });
  });
});

async function charConv(character: "alfred" | "lucius", updatedAt: Date, archived = false) {
  const [c] = await db
    .insert(characterConversationsTable)
    .values({
      userId,
      character,
      subjectType: character === "alfred" ? "alfred_thread" : "agent",
      subjectId: character === "alfred" ? null : "7",
      aiModelId: modelId,
      title: "Filo",
      updatedAt,
      archivedAt: archived ? updatedAt : null,
    })
    .returning();
  await db.insert(characterMessagesTable).values([
    { conversationId: c!.id, role: "user", content: "Vorrei il piano B" },
    { conversationId: c!.id, role: "assistant", content: "Ok, piano B" },
  ]);
  return c!.id;
}
const getChar = async (id: number) => (await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, id)))[0]!;

describe("conversazioni dei personaggi", () => {
  it("summarizes_character_conversations: Lucius e Alfred (anche archiviata) finiscono nello storico", async () => {
    const lucius = await charConv("lucius", minutesAgo(31));
    const alfred = await charConv("alfred", minutesAgo(31), true);
    expect(await sweepSummaries()).toBe(2);
    const rows = await history();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.refId === lucius)).toMatchObject({ character: "lucius", kind: "character_chat", userId });
    expect(rows.find((r) => r.refId === alfred)).toMatchObject({ character: "alfred", kind: "character_chat", userId });
    expect((await getChar(lucius)).summarizedAt).not.toBeNull();
  });

  it("la trascrizione di una conversazione di Alfred dice «Alfred:», mai «Lucius:»", async () => {
    await charConv("alfred", minutesAgo(31));
    await sweepSummaries();
    const body = fake.requests.find((r) => r.path.endsWith("/chat/completions"))!.body as { messages: { content: string }[] };
    expect(body.messages[1]!.content).toBe("Utente: Vorrei il piano B\n\nAlfred: Ok, piano B");
    expect(body.messages[1]!.content).not.toContain("Lucius:");
  });

  it("summary_skipped_on_character_cap: tetto di Lucius raggiunto, nessun riassunto ma summarized_at scritto", async () => {
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0.01" }).where(eq(usersTable.id, userId));
    await db.insert(characterHistoryTable).values({ userId, character: "lucius", kind: "team_chat", refId: 999, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 10, costUsd: "0.05" });
    const id = await charConv("lucius", minutesAgo(31));
    const plan = await planConv(minutesAgo(31));
    await sweepSummaries();
    expect(await history()).toHaveLength(1);
    expect((await getChar(id)).summarizedAt).not.toBeNull();
    expect((await getPlan(plan)).summarizedAt).not.toBeNull();
    expect(fake.requests.filter((r) => r.path.endsWith("/chat/completions"))).toHaveLength(0);
  });
});

describe("summarizeConversation", () => {
  const input = () => ({ userId, character: "lucius" as const, kind: "plan_conversation" as const, refId: 7, title: "T", transcript: "Utente: x" });

  it("errore del provider: skipped", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await summarizeConversation(input(), { chat })).toBe("skipped");
    expect(await history()).toHaveLength(0);
  });

  it("modello predefinito di un altro utente: skipped, senza chiamare il modello", async () => {
    const [other] = await db.insert(usersTable).values({ email: "o@x.it" }).returning();
    const chat = vi.fn();
    expect(await summarizeConversation({ ...input(), userId: other!.id }, { chat })).toBe("skipped");
    expect(chat).not.toHaveBeenCalled();
  });

  it("chat iniettata e richiesta con prompt fisso, 1 000 token, 30 s", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "ok", toolCalls: [], promptTokens: 5, completionTokens: 5, cachedPromptTokens: 0, costUsd: null });
    expect(await summarizeConversation(input(), { chat })).toBe("saved");
    const [row] = await history();
    expect(row!.costUsd).toBeNull();
    expect(chat.mock.calls[0]![1][0].content).toContain("decisioni prese");
  });

  it("tetto di spesa dell'utente raggiunto: nessuna chiamata al modello, nessuna voce", async () => {
    await db.update(usersTable).set({ monthlyBudgetUsd: "0.01" }).where(eq(usersTable.id, userId));
    await db.insert(characterHistoryTable).values({ userId, character: "alfred", kind: "alfred_session", refId: 1, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 10, costUsd: "0.05" });
    const chat = vi.fn();
    expect(await summarizeConversation(input(), { chat })).toBe("skipped");
    expect(chat).not.toHaveBeenCalled();
    expect(await history()).toHaveLength(1);
  });

  it("richiesta al provider: max_tokens 1000", async () => {
    await summarizeConversation(input());
    const body = fake.requests.find((r) => r.path.endsWith("/chat/completions"))!.body as { max_tokens?: number };
    expect(body.max_tokens).toBe(1000);
  });
});

describe("costi dei riassunti", () => {
  const chatCost = (cost: number | null) =>
    vi.fn().mockResolvedValue({ content: "r", toolCalls: [], promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0, costUsd: cost });
  const input = { userId: 0, character: "lucius" as const, kind: "plan_conversation" as const, refId: 9, title: "T", transcript: "Utente: x" };

  it("due riassunti della stessa conversazione: una riga, costo e token sommati, spesa 0,03", async () => {
    await summarizeConversation({ ...input, userId }, { chat: chatCost(0.01) });
    await summarizeConversation({ ...input, userId }, { chat: chatCost(0.02) });
    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.03, 6);
    expect(rows[0]!.tokensUsed).toBe(30);
    expect((await userSpend(userId)).spentUsd).toBeCloseTo(0.03, 6);
  });

  it("prezzo mancante in uno dei due: costo nullo", async () => {
    await summarizeConversation({ ...input, userId }, { chat: chatCost(0.01) });
    await summarizeConversation({ ...input, userId }, { chat: chatCost(null) });
    expect((await history())[0]!.costUsd).toBeNull();
  });
});

describe("storico eliminato e spesa", () => {
  it("eliminare una voce non cancella il costo dalla spesa", async () => {
    await summarizeConversation({ userId, character: "lucius", kind: "plan_conversation", refId: 5, title: "T", transcript: "Utente: x" });
    const before = (await userSpend(userId)).spentUsd;
    expect(before).toBeGreaterThan(0);
    const [row] = await history();
    const { deleteHistory } = await import("./history");
    await deleteHistory(userId, "lucius", row!.id);
    expect((await userSpend(userId)).spentUsd).toBeCloseTo(before, 9);
  });
});

describe("runMemoryTool", () => {
  it("ricorda, aggiorna, dimentica, cerca", async () => {
    const added = await runMemoryTool(userId, "lucius", "ricorda", { testo: "Preferisce risposte brevi" });
    expect(added.ok).toBe(true);
    const id = (added as { ok: true; result: { id: number } }).result.id;
    expect(await runMemoryTool(userId, "lucius", "aggiorna_appunto", { id, testo: "Preferisce risposte lunghe" })).toEqual({ ok: true, result: { updated: id } });
    expect(await runMemoryTool(userId, "lucius", "dimentica", { id })).toEqual({ ok: true, result: { deleted: id } });
    expect(await runMemoryTool(userId, "lucius", "dimentica", { id })).toEqual({ ok: false, error: MEMORY_MESSAGES.notFound });
    await db.insert(characterHistoryTable).values({ userId, character: "lucius", kind: "team_chat", refId: 1, title: "Ordini", summary: "decisa la fatturazione" });
    const found = await runMemoryTool(userId, "lucius", "cerca_nello_storico", { testo: "fatturazione" });
    expect(found).toMatchObject({ ok: true, result: [{ title: "Ordini", summary: "decisa la fatturazione" }] });
  });

  it("argomenti non validi, credenziali, sconosciuto, memoria piena", async () => {
    expect(await runMemoryTool(userId, "lucius", "ricorda", {})).toEqual({ ok: false, error: "argomenti non validi" });
    expect(await runMemoryTool(userId, "lucius", "dimentica", { id: "x" })).toEqual({ ok: false, error: "argomenti non validi" });
    expect(await runMemoryTool(userId, "lucius", "ricorda", { testo: "sk-proj-abc123" })).toEqual({ ok: false, error: MEMORY_MESSAGES.credential });
    expect((await runMemoryTool(userId, "lucius", "boh", {})).ok).toBe(false);
    for (let i = 0; i < 50; i++) expect((await runMemoryTool(userId, "lucius", "ricorda", { testo: `appunto ${i}` })).ok).toBe(true);
    expect(await runMemoryTool(userId, "lucius", "ricorda", { testo: "il cinquantunesimo" })).toEqual({ ok: false, error: MEMORY_MESSAGES.full });
  });

  it("dichiara quattro strumenti", () => {
    expect(MEMORY_TOOLS.map((t) => t.function.name)).toEqual(["ricorda", "aggiorna_appunto", "dimentica", "cerca_nello_storico"]);
  });
});
