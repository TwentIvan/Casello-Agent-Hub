import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
import { encryptSecret } from "../secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import {
  INTERRUPTED_TURN_MESSAGE,
  TurnBusyError,
  failInterruptedPlanTurns,
  loadPlanItems,
  startPlanTurn,
} from "./run-turn";

const ACCOUNT_KEY = "sk-CHIAVE-DELLA-CHAT";
const SECRET_URL = "https://segreto.example";

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

let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let appId: number;
let analysisId: number;
let modelId: number;
let conversationId: number;
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
  fake = await startFakeProvider({ apiKey: ACCOUNT_KEY });
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "a@x.it" }).returning();
  userId = user!.id;
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: SECRET_URL,
      serviceSecretEnc: encryptSecret("SEGRETO-DI-SERVIZIO"),
      functionalDescription: "Fantacalcio",
    })
    .returning();
  appId = app!.id;
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
    .returning();
  analysisId = analysis!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(ACCOUNT_KEY), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
  const [conv] = await db
    .insert(planConversationsTable)
    .values({ appId, analysisId, userId, aiModelId: modelId, title: "" })
    .returning();
  conversationId = conv!.id;
});

afterEach(async () => {
  await waitIdle(conversationId);
  await fake.close();
});

/** Attende la fine del turno in background: niente deve girare oltre il test. */
async function waitIdle(id: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [c] = await db.select().from(planConversationsTable).where(eq(planConversationsTable.id, id));
    if (!c || c.turnStatus === "idle") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("turno non terminato");
}

const getConv = async () => (await db.select().from(planConversationsTable).where(eq(planConversationsTable.id, conversationId)))[0]!;
const getMessages = () => db.select().from(planMessagesTable).where(eq(planMessagesTable.conversationId, conversationId)).orderBy(planMessagesTable.id);

describe("turni della chat del piano", () => {
  it("un turno con una proposta salva messaggio, proposta, token e torna idle", async () => {
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

    const userMessage = await startPlanTurn(conversationId, "Aggiungi gli ordini\ne altro");
    expect(userMessage).toMatchObject({ role: "user", content: "Aggiungi gli ordini\ne altro" });
    await waitIdle(conversationId);

    const messages = await getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Ho proposto una voce.", error: false, tokens: 250 });
    const proposals = await db.select().from(planProposalsTable);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ conversationId, messageId: messages[1]!.id, kind: "add", chapter: "completion", status: "pending" });
    const conv = await getConv();
    expect(conv).toMatchObject({ turnStatus: "idle", tokensUsed: 250, title: "Aggiungi gli ordini e altro" });
    expect(Number(conv.costUsd)).toBeGreaterThan(0);
  });

  it("il contesto inviato al provider non contiene base_url né segreti dell'app", async () => {
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);

    const sent = JSON.stringify(fake.requests.filter((r) => r.path.includes("chat/completions")).map((r) => r.body));
    expect(sent).toContain("Mister");
    expect(sent).not.toContain("segreto.example");
    expect(sent).not.toContain("SEGRETO-DI-SERVIZIO");
  });

  it("errore del provider → messaggio di errore e conversazione idle", async () => {
    fake.statusFor = { chat: 500 };
    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);

    const messages = await getMessages();
    expect(messages[1]!.error).toBe(true);
    expect(messages[1]!.content.length).toBeGreaterThan(0);
    expect((await getConv()).turnStatus).toBe("idle");
  });

  it("senza modello → messaggio d'errore e conversazione idle", async () => {
    await db.update(planConversationsTable).set({ aiModelId: null }).where(eq(planConversationsTable.id, conversationId));
    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);

    const messages = await getMessages();
    expect(messages[1]).toMatchObject({ error: true, content: "Scegli un modello per la conversazione." });
  });

  it("secondo startPlanTurn durante un turno → TurnBusyError", async () => {
    fake.delayMs = 150;
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    await startPlanTurn(conversationId, "uno");
    await expect(startPlanTurn(conversationId, "due")).rejects.toBeInstanceOf(TurnBusyError);
    await waitIdle(conversationId);
    expect(await getMessages()).toHaveLength(2);
  });

  it("le voci da chat approvate delle analisi precedenti sono nel piano", async () => {
    const [old] = await db
      .insert(analysesTable)
      .values({ appId, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
      .returning();
    const base = { diff: "new" as const, position: 0 };
    await db.insert(analysisItemsTable).values([
      { ...base, analysisId, chapter: "completion", ref: "completion:1", payload: completion("a") },
      { ...base, analysisId, chapter: "tool", ref: "tool:x", payload: { name: "x" } },
      { ...base, analysisId: old!.id, chapter: "completion", ref: "chat:1", payload: completion("b"), origin: "chat", status: "approved" },
      { ...base, analysisId: old!.id, chapter: "completion", ref: "chat:2", payload: completion("c"), origin: "chat", status: "pending" },
      { ...base, analysisId: old!.id, chapter: "completion", ref: "arch:1", payload: completion("d"), status: "approved" },
    ]);

    const items = await loadPlanItems(analysisId, appId);
    expect(items.map((i) => i.ref).sort()).toEqual(["chat:1", "completion:1"]);
  });

  it("cronologia: finisce con l'utente, senza assistant vuoti, e la scelta di scartare porta il titolo della voce", async () => {
    const [item] = await db
      .insert(analysisItemsTable)
      .values({ analysisId, chapter: "completion", ref: "completion:1", position: 0, diff: "new", payload: completion("k", "Titolo bersaglio") })
      .returning();
    const [, old] = await db
      .insert(planMessagesTable)
      .values([
        { conversationId, role: "user", content: "vecchia domanda" },
        { conversationId, role: "assistant", content: "vecchia risposta" },
      ])
      .returning();
    await db.insert(planProposalsTable).values({
      conversationId,
      messageId: old!.id,
      kind: "discard",
      chapter: "completion",
      payload: null,
      rationale: "r",
      targetItemId: item!.id,
      targetHash: "h",
    });
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };

    await startPlanTurn(conversationId, "nuova domanda");
    await waitIdle(conversationId);

    const req = fake.requests.find((r) => r.path.includes("chat/completions"))!;
    const sent = (req.body as { messages: { role: string; content: string }[] }).messages;
    expect(sent[sent.length - 1]).toMatchObject({ role: "user", content: "nuova domanda" });
    expect(sent.some((m) => m.role === "assistant" && m.content === "")).toBe(false);
    expect(sent.some((m) => m.role === "assistant" && m.content.includes("vecchia risposta") && m.content.includes("Titolo bersaglio"))).toBe(true);
  });

  it("errore del DB in uno strumento → messaggio di errore e conversazione idle", async () => {
    await pool.query(`CREATE FUNCTION fail_proposal() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER fail_proposal BEFORE INSERT ON plan_proposals FOR EACH ROW EXECUTE FUNCTION fail_proposal()`);
    try {
      fake.chatReply = {
        content: null,
        toolCalls: [{ id: "c1", name: "propose", arguments: JSON.stringify({ kind: "add", chapter: "completion", payload: completion("k1"), rationale: "serve" }) }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      };
      await startPlanTurn(conversationId, "ciao");
      await waitIdle(conversationId);
    } finally {
      await pool.query("DROP TRIGGER fail_proposal ON plan_proposals");
      await pool.query("DROP FUNCTION fail_proposal()");
    }
    const messages = await getMessages();
    expect(messages[1]!.error).toBe(true);
    expect(messages[1]!.content.length).toBeGreaterThan(0);
    expect((await getConv()).turnStatus).toBe("idle");
  });

  it("modello senza prezzi: il costo della conversazione resta null", async () => {
    await db.update(aiModelsTable).set({ priceInputPerMtok: null, priceOutputPerMtok: null }).where(eq(aiModelsTable.id, modelId));
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);

    const conv = await getConv();
    expect(conv.tokensUsed).toBe(120);
    expect(conv.costUsd).toBeNull();
  });

  it("il costo si somma tra due turni con un modello con prezzi", async () => {
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 20_000, completion_tokens: 5_000 } };
    await startPlanTurn(conversationId, "uno");
    await waitIdle(conversationId);
    const first = Number((await getConv()).costUsd);
    expect(first).toBeCloseTo(0.03, 6);

    await startPlanTurn(conversationId, "due");
    await waitIdle(conversationId);
    const conv = await getConv();
    expect(conv.tokensUsed).toBe(50_000);
    expect(Number(conv.costUsd)).toBeCloseTo(first * 2, 6);
  });

  it("un turno ok con risposta vuota salva il segnaposto testuale", async () => {
    fake.chatReply = () => ({ content: "", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 0 } });
    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);
    const messages = await getMessages();
    expect(messages[1]).toMatchObject({ role: "assistant", content: "(nessuna risposta testuale)", error: false });
  });

  it("failInterruptedPlanTurns riscrive solo l'ultimo messaggio assistant vuoto", async () => {
    await db.update(planConversationsTable).set({ turnStatus: "running" }).where(eq(planConversationsTable.id, conversationId));
    await db.insert(planMessagesTable).values([
      { conversationId, role: "user", content: "uno" },
      { conversationId, role: "assistant", content: "" },
      { conversationId, role: "user", content: "due" },
      { conversationId, role: "assistant", content: "" },
    ]);
    await failInterruptedPlanTurns();
    const messages = await getMessages();
    expect(messages.map((m) => m.content)).toEqual(["uno", "", "due", INTERRUPTED_TURN_MESSAGE]);
    expect(messages[1]!.error).toBe(false);
    expect(messages[3]!.error).toBe(true);
  });

  it("failInterruptedPlanTurns rimette idle e aggiunge il messaggio di interruzione", async () => {
    await db.update(planConversationsTable).set({ turnStatus: "running" }).where(eq(planConversationsTable.id, conversationId));
    await db.insert(planMessagesTable).values([
      { conversationId, role: "user", content: "ciao" },
      { conversationId, role: "assistant", content: "" },
    ]);

    expect(await failInterruptedPlanTurns()).toBe(1);

    expect((await getConv()).turnStatus).toBe("idle");
    const messages = await getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ content: INTERRUPTED_TURN_MESSAGE, error: true });
    expect(await failInterruptedPlanTurns()).toBe(0);
  });
});
