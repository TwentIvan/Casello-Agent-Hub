import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appToolsTable,
  appsTable,
  characterHistoryTable,
  skillsTable,
  skillVersionsTable,
  teamChatConversationsTable,
  teamChatMessagesTable,
  teamChatProposalsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import type { InstanceRole } from "../teams/manifest";
import { closeInstance, createInstance, getInstance } from "../teams/instances";
import { InstanceError } from "../teams/instances";
import { currentValueHash } from "./decide";
import {
  TEAM_CHAT_MESSAGE_MAX_CHARS,
  TurnBusyError,
  failInterruptedTeamChatTurns,
  startTeamChatTurn,
} from "./run-turn";

const ACCOUNT_KEY = "sk-CHIAVE-DELLA-CHAT";
const SECRET_URL = "https://segreto.example";
const INTERNAL_URL = "http://interno.example:8080";

let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let modelId: number;
let instanceId: number;
let conversationId: number;
const savedKey = process.env["CASELLO_SECRET_KEY"];

const MD = (key: string) => `---\nname: ${key}\ndescription: Quando serve sviluppare\n---\n# Sviluppatore\n\n## Identità\nScrive codice.\n`;

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(async () => {
  restoreLoopback();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE apps, ai_accounts, users, skills, team_templates RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  fake = await startFakeProvider({ apiKey: ACCOUNT_KEY });
  await pool.query("TRUNCATE apps, ai_accounts, users, skills, team_templates RESTART IDENTITY CASCADE");
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
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: SECRET_URL,
      internalBaseUrl: INTERNAL_URL,
      serviceSecretEnc: encryptSecret("SEGRETO-DI-SERVIZIO"),
      serviceAuth: { header: "X-Chiave-Segreta", scheme: null },
    })
    .returning();
  const [tool] = await db
    .insert(appToolsTable)
    .values({
      appId: app!.id,
      name: "crea_ordine",
      description: "Crea un ordine",
      kind: "http",
      status: "active",
      level: "L2",
      definition: { method: "POST", path: "/ordini", paramLocations: { pin: "body" } },
      paramsSchema: { type: "object", properties: { pin: { type: "string", "x-sensitive": true, default: "PIN-SEGRETO" } } },
    })
    .returning();
  const [skill] = await db.insert(skillsTable).values({ code: "sap.review", name: "Review SAP", kind: "casello" }).returning();
  await db.insert(skillVersionsTable).values({ skillId: skill!.id, version: 1, content: "Contenuto della review SAP" });
  const roles: InstanceRole[] = [
    { key: "capo", name: "Capo", task: "Coordina", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [], localSkills: [] },
    { key: "dev", name: "Sviluppatore", task: "Sviluppa", isLead: false, runsOn: "cloud", aiModelId: modelId, tools: [tool!.id], skills: [{ code: "sap.review", version: 1 }], localSkills: [] },
  ];
  const view = await createInstance(userId, { name: "Squadra ordini", ref: { appId: app!.id, type: "wi", id: "1174" }, roles });
  instanceId = view.id;
  const [conv] = await db.insert(teamChatConversationsTable).values({ teamInstanceId: instanceId, userId, aiModelId: modelId, title: "" }).returning();
  conversationId = conv!.id;
});

afterEach(async () => {
  await waitIdle(conversationId);
  await fake.close();
});

async function waitIdle(id: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [c] = await db.select().from(teamChatConversationsTable).where(eq(teamChatConversationsTable.id, id));
    if (!c || c.turnStatus === "idle") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("turno non terminato");
}

const getConv = async () => (await db.select().from(teamChatConversationsTable).where(eq(teamChatConversationsTable.id, conversationId)))[0]!;
const getMessages = () => db.select().from(teamChatMessagesTable).where(eq(teamChatMessagesTable.conversationId, conversationId)).orderBy(teamChatMessagesTable.id);
const chatBodies = () => fake.requests.filter((r) => r.path.includes("chat/completions")).map((r) => r.body as { messages: Array<{ role: string; content: string | null }>; tools?: Array<{ function: { name: string } }> });

describe("turni della chat di squadra", () => {
  it("il modello propone le istruzioni: scheda pending con target_hash, token e costo registrati", async () => {
    let n = 0;
    fake.chatReply = () => {
      n += 1;
      return n === 1
        ? {
            content: null,
            toolCalls: [{ id: "c1", name: "proponi_istruzioni", arguments: JSON.stringify({ roleKey: "dev", markdown: MD("dev"), motivazione: "manca il manuale" }) }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }
        : { content: "Ho proposto le istruzioni.", toolCalls: [], usage: { prompt_tokens: 120, completion_tokens: 10 } };
    };
    const userMessage = await startTeamChatTurn(conversationId, "Scrivi le istruzioni\ndello sviluppatore");
    expect(userMessage).toMatchObject({ role: "user", content: "Scrivi le istruzioni\ndello sviluppatore" });
    await waitIdle(conversationId);

    const messages = await getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Ho proposto le istruzioni.", error: false, tokens: 250 });
    const proposals = await db.select().from(teamChatProposalsTable);
    expect(proposals).toHaveLength(1);
    const instance = await getInstance(instanceId);
    expect(proposals[0]).toMatchObject({
      conversationId,
      messageId: messages[1]!.id,
      kind: "role_instructions",
      roleKey: "dev",
      payload: { markdown: MD("dev") },
      rationale: "manca il manuale",
      status: "pending",
      targetHash: currentValueHash(instance, "role_instructions", "dev"),
    });
    const conv = await getConv();
    expect(conv).toMatchObject({ turnStatus: "idle", tokensUsed: 250, title: "Scrivi le istruzioni dello sviluppatore" });
    expect(Number(conv.costUsd)).toBeGreaterThan(0);
    // Gli strumenti offerti: quelli di Lucius e quelli di memoria
    expect(chatBodies()[0]!.tools!.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(["leggi_squadra", "leggi_skill", "leggi_strumento", "proponi_identita", "proponi_istruzioni", "ricorda", "cerca_nello_storico"]),
    );
  });

  it("l'undicesima proposta dello stesso turno è rifiutata", async () => {
    let n = 0;
    fake.chatReply = () => {
      n += 1;
      if (n > 1) return { content: "Fatto.", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      return {
        content: null,
        toolCalls: Array.from({ length: 11 }, (_, i) => ({
          id: `c${i}`,
          name: "proponi_identita",
          arguments: JSON.stringify({ roleKey: i % 2 ? "dev" : "capo", testo: `Identità ${i}`, motivazione: "più chiara" }),
        })),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    };
    await startTeamChatTurn(conversationId, "Proponi tutto");
    await waitIdle(conversationId);
    expect(await db.select().from(teamChatProposalsTable)).toHaveLength(10);
    const toolResults = chatBodies()[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(toolResults[10]).toContain("hai già proposto 10 schede in questo turno");
  });

  it("il contesto non contiene indirizzi, header né segreti dell'app; c'è la squadra con skill e strumenti", async () => {
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    await startTeamChatTurn(conversationId, "ciao");
    await waitIdle(conversationId);
    const sent = JSON.stringify(chatBodies());
    expect(sent).toContain("Squadra ordini");
    expect(sent).toContain("Contenuto della review SAP");
    expect(sent).toContain("crea_ordine");
    expect(sent).not.toContain("segreto.example");
    expect(sent).not.toContain("interno.example");
    expect(sent).not.toContain("SEGRETO-DI-SERVIZIO");
    expect(sent).not.toContain("X-Chiave-Segreta");
    // La squadra arriva come dato (user), non nel prompt di sistema
    const system = chatBodies()[0]!.messages.find((m) => m.role === "system")!.content!;
    expect(system).not.toContain("Squadra ordini");
    expect(system).toContain("Lucius");
  });

  it("senza modello: messaggio d'errore e conversazione idle", async () => {
    await db.update(teamChatConversationsTable).set({ aiModelId: null }).where(eq(teamChatConversationsTable.id, conversationId));
    await startTeamChatTurn(conversationId, "ciao");
    await waitIdle(conversationId);
    expect((await getMessages())[1]).toMatchObject({ error: true, content: "Scegli un modello per la conversazione." });
  });

  it("tetto di Lucius raggiunto: messaggio d'errore «Tetto di spesa mensile di Lucius…», nessuna chiamata al provider", async () => {
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0.01" }).where(eq(usersTable.id, userId));
    await db.insert(characterHistoryTable).values({ userId, character: "lucius", kind: "team_chat", refId: 996, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 10, costUsd: "0.05" });
    await startTeamChatTurn(conversationId, "ciao");
    await waitIdle(conversationId);
    const msg = (await getMessages())[1]!;
    expect(msg.error).toBe(true);
    expect(msg.content).toContain("Tetto di spesa mensile di Lucius raggiunto");
    expect(fake.requests.filter((r) => r.path.includes("chat/completions"))).toHaveLength(0);
  });

  it("tetto di spesa raggiunto: messaggio d'errore col motivo, nessuna chiamata al modello", async () => {
    await db.update(usersTable).set({ monthlyBudgetUsd: "0" }).where(eq(usersTable.id, userId));
    await startTeamChatTurn(conversationId, "ciao");
    await waitIdle(conversationId);
    const last = (await getMessages())[1]!;
    expect(last.error).toBe(true);
    expect(last.content.length).toBeGreaterThan(0);
    expect(chatBodies()).toHaveLength(0);
  });

  it("turno in corso → TurnBusyError; squadra chiusa → 409", async () => {
    fake.delayMs = 150;
    fake.chatReply = { content: "ok", toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    await startTeamChatTurn(conversationId, "uno");
    await expect(startTeamChatTurn(conversationId, "due")).rejects.toBeInstanceOf(TurnBusyError);
    await waitIdle(conversationId);
    await closeInstance(instanceId);
    const err = await startTeamChatTurn(conversationId, "tre").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstanceError);
    expect(err).toMatchObject({ status: 409, message: "squadra chiusa" });
    expect(TEAM_CHAT_MESSAGE_MAX_CHARS).toBe(8_000);
  });

  it("all'avvio i turni rimasti running si chiudono con un messaggio d'errore", async () => {
    await db.update(teamChatConversationsTable).set({ turnStatus: "running" }).where(eq(teamChatConversationsTable.id, conversationId));
    await db.insert(teamChatMessagesTable).values([
      { conversationId, role: "user", content: "ciao" },
      { conversationId, role: "assistant", content: "" },
    ]);
    expect(await failInterruptedTeamChatTurns()).toBe(1);
    expect((await getConv()).turnStatus).toBe("idle");
    expect((await getMessages())[1]).toMatchObject({ error: true, content: "Turno interrotto dal riavvio di Botcave: riscrivi il messaggio." });
  });
});
