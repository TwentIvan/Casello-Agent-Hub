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
  characterHistoryTable,
  githubInstallationsTable,
  planConversationsTable,
  planMessagesTable,
  planProposalsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { clearCodeCache, setCodeCacheOptionsForTests } from "../code-reader/source-cache";
import { buildZip } from "../zip-writer";
import { listNotes } from "../memory/notes";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import {
  INTERRUPTED_TURN_MESSAGE,
  PLAN_CHAT_SPEC,
  TurnBusyError,
  executePlanTurn,
  failInterruptedPlanTurns,
  loadPlanItems,
  startPlanTurn,
} from "./run-turn";
import { decideProposal } from "./decide";
import { closeTurnAsStopped, queueChatMessage, stopChatTurn } from "../chat-turns/control";
import { isLiveTurn } from "../stale-turns";

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

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condizione non raggiunta");
}

const chatBodies = () =>
  fake.requests.filter((r) => r.path.includes("chat/completions")).map((r) => r.body as { messages: Array<{ role: string; content: string | null }> });

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

  it("tetto di Lucius raggiunto: messaggio d'errore «Tetto di spesa mensile di Lucius…», nessuna chiamata al provider", async () => {
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0.01" }).where(eq(usersTable.id, userId));
    await db.insert(characterHistoryTable).values({ userId, character: "lucius", kind: "team_chat", refId: 996, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 10, costUsd: "0.05" });
    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);
    const msg = (await getMessages())[1]!;
    expect(msg.error).toBe(true);
    expect(msg.content).toContain("Tetto di spesa mensile di Lucius raggiunto");
    expect(fake.requests.filter((r) => r.path.includes("chat/completions"))).toHaveLength(0);
  });

  it("secondo startPlanTurn durante un turno → TurnBusyError", async () => {
    fake.delayMs = 150;
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    await startPlanTurn(conversationId, "uno");
    await expect(startPlanTurn(conversationId, "due")).rejects.toBeInstanceOf(TurnBusyError);
    await waitIdle(conversationId);
    expect(await getMessages()).toHaveLength(2);
  });

  it("le voci approvate delle analisi precedenti da chat o con un'issue sono nel piano", async () => {
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
      // Voce dell'architetto con un'issue: resta nel piano anche dopo la rianalisi
      { ...base, analysisId: old!.id, chapter: "completion", ref: "arch:2", payload: completion("e"), status: "approved", issueRepo: "ivan/mister", issueNumber: 4, issueState: "open" },
      { ...base, analysisId: old!.id, chapter: "completion", ref: "arch:3", payload: completion("f"), status: "discarded", issueRepo: "ivan/mister", issueNumber: 5, issueState: "closed" },
    ]);

    const items = await loadPlanItems(analysisId, appId);
    expect(items.map((i) => i.ref).sort()).toEqual(["arch:2", "chat:1", "completion:1"]);
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

  it("turni appesi: chiude solo quelli più vecchi del filtro e non esclusi", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    await db.update(planConversationsTable).set({ turnStatus: "running", updatedAt: old }).where(eq(planConversationsTable.id, conversationId));
    await db.insert(planMessagesTable).values([
      { conversationId, role: "user", content: "ciao" },
      { conversationId, role: "assistant", content: "" },
    ]);
    // Escluso (turno vivo in questo processo): resta in corso
    expect(await failInterruptedPlanTurns({ olderThan: new Date(Date.now() - 5 * 60_000), exclude: [conversationId] })).toBe(0);
    // Più recente del filtro: resta in corso
    expect(await failInterruptedPlanTurns({ olderThan: new Date(Date.now() - 20 * 60_000), exclude: [] })).toBe(0);
    expect((await getConv()).turnStatus).toBe("running");
    // Appeso da oltre 5 minuti e non vivo qui: chiuso con il messaggio del riavvio
    expect(await failInterruptedPlanTurns({ olderThan: new Date(Date.now() - 5 * 60_000), exclude: [] })).toBe(1);
    expect((await getConv()).turnStatus).toBe("idle");
    expect((await getMessages())[1]).toMatchObject({ content: INTERRUPTED_TURN_MESSAGE, error: true });
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

  it("ricorda crea un appunto di Lucius e il turno seguente lo vede nel messaggio user", async () => {
    let n = 0;
    fake.chatReply = () => {
      n += 1;
      return n === 1
        ? { content: null, toolCalls: [{ id: "m1", name: "ricorda", arguments: JSON.stringify({ testo: "preferisce risposte brevi" }) }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
        : { content: "Annotato.", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    };
    await startPlanTurn(conversationId, "ricordati che preferisco risposte brevi");
    await waitIdle(conversationId);
    const notes = await listNotes(userId, "lucius");
    expect(notes.map((x) => x.content)).toEqual(["preferisce risposte brevi"]);

    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    fake.requests.length = 0;
    await startPlanTurn(conversationId, "e adesso?");
    await waitIdle(conversationId);
    const body = fake.requests.find((r) => r.path.includes("chat/completions"))!.body as { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> };
    expect(body.messages.find((m) => m.role === "system")!.content).not.toContain("preferisce risposte brevi");
    expect(body.messages.find((m) => m.role === "user")!.content).toContain("preferisce risposte brevi");
    expect(body.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["propose", "ricorda", "cerca_nello_storico"]));
  });
});

describe("Ferma e Accoda nella chat del piano", () => {
  /** Primo giro: una proposta e 120 token; il secondo giro resta in attesa del provider per `delayMs`. */
  function slowSecondRound(delayMs: number): void {
    let n = 0;
    fake.chatReply = () => {
      n += 1;
      if (n === 1) {
        fake.delayMs = delayMs;
        return {
          content: null,
          toolCalls: [{ id: "c1", name: "propose", arguments: JSON.stringify({ kind: "add", chapter: "completion", payload: completion("k1"), rationale: "serve" }) }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        };
      }
      return { content: "Risposta tardiva", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
    };
  }

  afterEach(async () => {
    await waitFor(() => !isLiveTurn("plan", conversationId));
  });

  it("stop durante il turno → «Risposta interrotta.», error false, conversazione idle, token del primo giro registrati", async () => {
    slowSecondRound(2_000);
    await startPlanTurn(conversationId, "Ciao");
    await waitFor(() => chatBodies().length === 2);
    const t0 = Date.now();
    expect(await stopChatTurn(PLAN_CHAT_SPEC, conversationId)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_500);
    const messages = await getMessages();
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Risposta interrotta.", error: false, tokens: 120 });
    expect(await getConv()).toMatchObject({ turnStatus: "idle", tokensUsed: 120 });
  });

  it("scheda salvata prima dello stop resta pending e si accetta", async () => {
    slowSecondRound(2_000);
    await startPlanTurn(conversationId, "Ciao");
    await waitFor(() => chatBodies().length === 2);
    await stopChatTurn(PLAN_CHAT_SPEC, conversationId);
    const messages = await getMessages();
    const cards = await db.select().from(planProposalsTable).where(eq(planProposalsTable.messageId, messages[1]!.id));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "add", status: "pending" });
    const decided = await decideProposal(cards[0]!.id, userId, "accept");
    expect(decided.proposal.status).toBe("accepted");
    expect(decided.item).not.toBeNull();
  });

  it("turno chiuso altrove: il messaggio resta «Risposta interrotta.», i token spesi si sommano, stato e updated_at no", async () => {
    slowSecondRound(300);
    await startPlanTurn(conversationId, "Ciao");
    await waitFor(() => chatBodies().length === 2);
    expect(await closeTurnAsStopped(PLAN_CHAT_SPEC, conversationId)).toBe(true);
    const closedAt = (await getConv()).updatedAt;
    await waitFor(() => !isLiveTurn("plan", conversationId));
    expect((await getMessages())[1]).toMatchObject({ content: "Risposta interrotta.", error: false, tokens: 0 });
    expect(await getConv()).toMatchObject({ turnStatus: "idle", tokensUsed: 240 });
    expect((await getConv()).updatedAt).toEqual(closedAt);
  });

  it("a fine turno parte il messaggio in coda", async () => {
    fake.delayMs = 300;
    fake.chatReply = { content: "Risposta", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    await startPlanTurn(conversationId, "Primo");
    const queued = await queueChatMessage(PLAN_CHAT_SPEC, conversationId, "Dopo", null);
    await waitFor(async () => (await getMessages()).length === 4 && (await getConv()).turnStatus === "idle" && !isLiveTurn("plan", conversationId));
    const messages = await getMessages();
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Primo"],
      ["assistant", "Risposta"],
      ["user", "Dopo"],
      ["assistant", "Risposta"],
    ]);
    expect(messages.every((m) => m.queuedAt === null)).toBe(true);
    expect(messages[2]!.id).toBeGreaterThan(queued.id);
    expect(chatBodies()[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "Dopo" });
  });

  it("la cronologia non contiene il messaggio in coda", async () => {
    fake.chatReply = { content: "Risposta", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    await db.update(planConversationsTable).set({ turnStatus: "running" }).where(eq(planConversationsTable.id, conversationId));
    await db.insert(planMessagesTable).values({ conversationId, role: "user", content: "Ciao" });
    await queueChatMessage(PLAN_CHAT_SPEC, conversationId, "In coda", null);
    const [assistant] = await db.insert(planMessagesTable).values({ conversationId, role: "assistant", content: "" }).returning();
    await executePlanTurn(conversationId, assistant!.id);
    const first = chatBodies()[0]!;
    expect(first.messages.at(-1)).toMatchObject({ role: "user", content: "Ciao" });
    expect(JSON.stringify(first.messages)).not.toContain("In coda");
    await waitFor(async () => chatBodies().length === 2 && (await getConv()).turnStatus === "idle");
    expect(chatBodies()[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "In coda" });
    expect(JSON.stringify(chatBodies()[1]!.messages).split("In coda")).toHaveLength(2);
  });

  it("turno chiuso nel DB prima di partire: nessuna chiamata, nessuna scrittura, poi la coda", async () => {
    fake.chatReply = { content: "Risposta", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    await db.insert(planMessagesTable).values({ conversationId, role: "user", content: "Ciao" });
    const [assistant] = await db.insert(planMessagesTable).values({ conversationId, role: "assistant", content: "Risposta interrotta." }).returning();
    await queueChatMessage(PLAN_CHAT_SPEC, conversationId, "In coda", null);
    await executePlanTurn(conversationId, assistant!.id);
    await waitFor(async () => (await getConv()).turnStatus === "idle" && !isLiveTurn("plan", conversationId));
    expect(chatBodies()).toHaveLength(1);
    expect(chatBodies()[0]!.messages.at(-1)).toMatchObject({ role: "user", content: "In coda" });
    expect((await getMessages())[1]).toMatchObject({ content: "Risposta interrotta.", tokens: 0 });
    expect((await getConv()).tokensUsed).toBe(15);
  });

  it("fermato prima che il messaggio dell'assistente fosse scritto: il messaggio vuoto diventa «Risposta interrotta.»", async () => {
    fake.chatReply = { content: "Risposta", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    await db.insert(planMessagesTable).values({ conversationId, role: "user", content: "Ciao" });
    // Conversazione già `idle` (Ferma l'ha chiusa prima dell'inserimento) e messaggio dell'assistente ancora vuoto
    const [assistant] = await db.insert(planMessagesTable).values({ conversationId, role: "assistant", content: "" }).returning();
    await executePlanTurn(conversationId, assistant!.id);
    await waitFor(() => !isLiveTurn("plan", conversationId));
    expect(chatBodies()).toHaveLength(0);
    expect((await getMessages())[1]).toMatchObject({ content: "Risposta interrotta.", error: false, tokens: 0 });
    expect(await getConv()).toMatchObject({ turnStatus: "idle", tokensUsed: 0 });
  });
});

describe("lettura del codice nella chat del piano", () => {
  const SHA = "abcdef1234567890".repeat(2) + "abcdef12";
  let gh: FakeGithub;

  const chatRequests = () => fake.requests.filter((r) => r.path.includes("chat/completions"));
  const toolNames = (body: unknown): string[] =>
    ((body as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);

  beforeAll(async () => {
    gh = await startFakeGithub();
  });
  afterAll(async () => {
    setCodeCacheOptionsForTests(null);
    await gh.close();
  });

  beforeEach(async () => {
    setCodeCacheOptionsForTests({
      githubConfig: {
        appId: gh.appId,
        slug: gh.slug,
        clientId: gh.clientId,
        clientSecret: gh.clientSecret,
        privateKey: gh.privateKeyPem,
        apiBase: gh.apiBase,
        webBase: gh.webBase,
      },
    });
    clearInstallationTokenCache();
    gh.installations.clear();
    gh.repos.clear();
    gh.revoked.clear();
    gh.issuedTokens.clear();
    gh.zipballs.clear();
    gh.commits.clear();
    gh.requests.length = 0;
    gh.failWith = null;
    gh.addInstallation({ id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
      { fullName: "ivan/fanta", defaultBranch: "main", private: true },
    ]);
    gh.zipballs.set("ivan/fanta", buildZip([{ name: "proj/src/a.ts", content: Buffer.from("export const alfa = 1;\n") }]));
    gh.commits.set("ivan/fanta", SHA);
    await db.insert(githubInstallationsTable).values({ userId, installationId: 11, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
  });
  afterEach(async () => {
    await waitIdle(conversationId);
    await clearCodeCache();
  });

  it("app collegata a GitHub: strumenti del codice offerti, risultato con sha7 e scheda discard salvata", async () => {
    await db
      .update(appsTable)
      .set({ sourceType: "github", sourceRepo: "ivan/fanta", sourceBranch: "main", sourceInstallationId: 11 })
      .where(eq(appsTable.id, appId));
    const [item] = await db
      .insert(analysisItemsTable)
      .values({ analysisId, chapter: "completion", ref: "completion:1", position: 0, diff: "new", payload: completion("k1", "Costante alfa") })
      .returning();
    let n = 0;
    fake.chatReply = () => {
      n += 1;
      if (n === 1) {
        return { content: null, toolCalls: [{ id: "c1", name: "cerca_nel_codice", arguments: JSON.stringify({ testo: "alfa" }) }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      }
      if (n === 2) {
        return {
          content: null,
          toolCalls: [{ id: "c2", name: "propose", arguments: JSON.stringify({ kind: "discard", chapter: "completion", targetRef: item!.ref, rationale: "già fatto in src/a.ts:1" }) }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      }
      return { content: "Fatto.", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    };

    await startPlanTurn(conversationId, "verifica il codice");
    await waitIdle(conversationId);

    const reqs = chatRequests();
    expect(toolNames(reqs[0]!.body)).toEqual(expect.arrayContaining(["elenca_cartella", "leggi_file", "cerca_nel_codice", "propose"]));
    const second = JSON.stringify(reqs[1]!.body);
    expect(second).toContain("Codice di Mister @ abcdef1");
    expect(second).toContain("src/a.ts:1");
    const system = (reqs[0]!.body as { messages: { role: string; content: string }[] }).messages[0]!.content;
    expect(system).toContain("Puoi leggere il codice dell'app");
    const proposals = await db.select().from(planProposalsTable);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "discard", status: "pending" });
  });

  it("app con zip: nessuno strumento del codice nella richiesta al modello", async () => {
    await db.update(appsTable).set({ sourceType: "zip" }).where(eq(appsTable.id, appId));
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };

    await startPlanTurn(conversationId, "ciao");
    await waitIdle(conversationId);

    const names = toolNames(chatRequests()[0]!.body);
    expect(names).toContain("propose");
    for (const t of ["elenca_cartella", "leggi_file", "cerca_nel_codice"]) expect(names).not.toContain(t);
    const system = (chatRequests()[0]!.body as { messages: { role: string; content: string }[] }).messages[0]!.content;
    expect(system).toContain("Non puoi leggere il codice di questa app");
  });
});
