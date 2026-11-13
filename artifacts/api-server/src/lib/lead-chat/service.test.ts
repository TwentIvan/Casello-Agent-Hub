import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  leadConversationsTable,
  leadMessagesTable,
  pendingActionsTable,
  runStepsTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { LEAD_CHAT_INPUT_MARKER } from "./input";
import { LEAD_CHAT_MESSAGES, LeadChatError } from "./messages";
import {
  createLeadConversation,
  deleteLeadConversation,
  getLeadConversation,
  listLeadConversations,
  resolveLeadChat,
  sendLeadMessage,
} from "./service";

// Chat con il Responsabile di Botcave sopra le run: la coda delle run non parte (le run restano `pending`), gli stati
// delle run si scrivono a mano. Il limite di 10 messaggi/min è in memoria: ogni test usa utenti nuovi.

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
});

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
});

let seq = 0;
async function seedUser(name = "Ivan") {
  const [user] = await db.insert(usersTable).values({ email: `lead${++seq}@example.com`, name }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: user!.id, name: `Account ${seq}`, provider: "custom", baseUrl: "https://llm.example/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "Modello M" }).returning();
  return { userId: user!.id, modelId: model!.id };
}

async function seedBotcave(modelId: number | null, opts: { appStatus?: "active" | "inactive"; leadStatus?: "active" | "draft" } = {}) {
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Botcave", slug: "casello", baseUrl: "http://casello.example", status: opts.appStatus ?? "active" })
    .returning();
  const [lead] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Responsabile di Botcave", role: "general", status: opts.leadStatus ?? "active", aiModelId: modelId })
    .returning();
  return { app: app!, lead: lead! };
}

async function setRun(runId: number, values: Partial<typeof runsTable.$inferInsert>) {
  await db.update(runsTable).set(values).where(eq(runsTable.id, runId));
}

async function runInput(runId: number) {
  const [r] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  return r!.input ?? "";
}

async function expectError(p: Promise<unknown>, status: number, message: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LeadChatError);
  expect((err as LeadChatError).status).toBe(status);
  expect((err as LeadChatError).message).toBe(message);
}

describe("resolveLeadChat", () => {
  it("motivi di indisponibilità e caso disponibile", async () => {
    const me = await seedUser();
    expect(await resolveLeadChat(me.userId)).toEqual({ available: false, reason: LEAD_CHAT_MESSAGES.noApp, agentId: null });

    const { lead } = await seedBotcave(me.modelId, { leadStatus: "draft" });
    expect(await resolveLeadChat(me.userId)).toEqual({ available: false, reason: LEAD_CHAT_MESSAGES.inactive, agentId: lead.id });

    await db.update(agentsTable).set({ status: "active", aiModelId: null }).where(eq(agentsTable.id, lead.id));
    expect(await resolveLeadChat(me.userId)).toEqual({ available: false, reason: LEAD_CHAT_MESSAGES.noModel, agentId: lead.id });

    const other = await seedUser("Altro");
    await db.update(agentsTable).set({ aiModelId: other.modelId }).where(eq(agentsTable.id, lead.id));
    expect(await resolveLeadChat(me.userId)).toEqual({ available: false, reason: LEAD_CHAT_MESSAGES.noModel, agentId: lead.id });

    await db.update(agentsTable).set({ aiModelId: me.modelId }).where(eq(agentsTable.id, lead.id));
    expect(await resolveLeadChat(me.userId)).toEqual({
      available: true,
      agentId: lead.id,
      agentName: "Responsabile di Botcave",
      appName: "Botcave",
      aiModelId: me.modelId,
      modelName: "Modello M",
    });
  });

  it("App inattiva: Botcave non disponibile", async () => {
    const me = await seedUser();
    await seedBotcave(me.modelId, { appStatus: "inactive" });
    expect(await resolveLeadChat(me.userId)).toEqual({ available: false, reason: LEAD_CHAT_MESSAGES.noApp, agentId: null });
  });
});

describe("conversazioni e messaggi", () => {
  it("un messaggio crea una run del Responsabile con pagina e marcatore, e dà il titolo", async () => {
    const me = await seedUser();
    const { lead } = await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    expect(conv.agentId).toBe(lead.id);

    const sent = await sendLeadMessage(me.userId, conv.id, { content: "Cosa manca a questa squadra?\nseconda riga", pageContext: { page: "team", id: "12" } });
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, sent.runId));
    expect(run!.agentId).toBe(lead.id);
    expect(run!.status).toBe("pending");
    expect(run!.input).toContain(LEAD_CHAT_INPUT_MARKER);
    expect(run!.input).toContain("Pagina della console: Squadra, id 12");
    const [msg] = await db.select().from(leadMessagesTable).where(eq(leadMessagesTable.id, sent.messageId));
    expect(msg!.runId).toBe(sent.runId);
    expect(msg!.pageContext).toEqual({ page: "team", id: "12" });

    const list = await listLeadConversations(me.userId);
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("Cosa manca a questa squadra?");
  });

  it("un messaggio alla volta; la cronologia riporta esito, errore o nessuna risposta", async () => {
    const me = await seedUser();
    await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    const first = await sendLeadMessage(me.userId, conv.id, { content: "uno" });
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "due" }), 409, LEAD_CHAT_MESSAGES.busy);

    await setRun(first.runId, { status: "running" });
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "due" }), 409, LEAD_CHAT_MESSAGES.busy);

    await setRun(first.runId, { status: "cancelled" });
    const second = await sendLeadMessage(me.userId, conv.id, { content: "due" });
    expect(await runInput(second.runId)).toContain("[utente] uno\n[responsabile] (nessuna risposta)");

    await setRun(second.runId, { status: "failed", errorMessage: "boom" });
    const third = await sendLeadMessage(me.userId, conv.id, { content: "tre" });
    expect(await runInput(third.runId)).toContain("[utente] due\n[responsabile] (errore: boom)");

    await setRun(third.runId, { status: "succeeded", output: "fatto" });
    const fourth = await sendLeadMessage(me.userId, conv.id, { content: "quattro" });
    expect(await runInput(fourth.runId)).toContain("[utente] tre\n[responsabile] fatto");
  });

  it("due invii simultanei: una sola run", async () => {
    const me = await seedUser();
    await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    const results = await Promise.allSettled([
      sendLeadMessage(me.userId, conv.id, { content: "uno" }),
      sendLeadMessage(me.userId, conv.id, { content: "due" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as LeadChatError).message).toBe(LEAD_CHAT_MESSAGES.busy);
    expect(await db.select().from(runsTable)).toHaveLength(1);
    expect(await db.select().from(leadMessagesTable)).toHaveLength(1);
  });

  it("testo, pagina, proprietà e archiviazione", async () => {
    const me = await seedUser();
    const other = await seedUser("Altro");
    await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "   " }), 400, LEAD_CHAT_MESSAGES.empty);
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "x".repeat(4001) }), 400, LEAD_CHAT_MESSAGES.tooLong);
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "x", pageContext: { page: "admin" } }), 400, LEAD_CHAT_MESSAGES.badPage);
    await expectError(sendLeadMessage(other.userId, conv.id, { content: "x" }), 404, LEAD_CHAT_MESSAGES.notFound);
    await expectError(getLeadConversation(other.userId, conv.id), 404, LEAD_CHAT_MESSAGES.notFound);
    await db.update(leadConversationsTable).set({ archivedAt: new Date() }).where(eq(leadConversationsTable.id, conv.id));
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "x" }), 409, LEAD_CHAT_MESSAGES.archived);
  });

  it("Responsabile senza modello o cambiato: 409, la conversazione resta leggibile", async () => {
    const me = await seedUser();
    const { app, lead } = await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    await db.update(agentsTable).set({ aiModelId: null }).where(eq(agentsTable.id, lead.id));
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "x" }), 409, LEAD_CHAT_MESSAGES.noModel);
    expect((await getLeadConversation(me.userId, conv.id)).id).toBe(conv.id);
    await expectError(createLeadConversation(me.userId), 409, LEAD_CHAT_MESSAGES.noModel);

    await db.update(agentsTable).set({ aiModelId: me.modelId, role: "area" }).where(eq(agentsTable.id, lead.id));
    await db.insert(agentsTable).values({ appId: app.id, name: "Nuovo", role: "general", status: "active", aiModelId: me.modelId });
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "x" }), 409, LEAD_CHAT_MESSAGES.changed);
  });

  it("dettaglio: avanzamento dagli ultimi 8 passi, voci in coda, run eliminata", async () => {
    const me = await seedUser();
    await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    const sent = await sendLeadMessage(me.userId, conv.id, { content: "uno" });
    await setRun(sent.runId, { status: "running" });
    for (let i = 0; i < 10; i++) {
      await db.insert(runStepsTable).values({ runId: sent.runId, position: i, type: i === 0 ? "model" : "tool", toolName: i === 0 ? null : `tool_${i}` });
    }
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, sent.runId));
    await db.insert(pendingActionsTable).values({
      userId: me.userId,
      number: 7,
      kind: "proposal",
      runId: sent.runId,
      agentId: run!.agentId,
      summary: "Crea la squadra",
      recipient: "Botcave",
      status: "pending",
      argsEnc: "x",
      argsPublic: {},
    } as typeof pendingActionsTable.$inferInsert);

    const running = await getLeadConversation(me.userId, conv.id);
    expect(running.turnStatus).toBe("running");
    expect(running.progress!.steps).toHaveLength(8);
    expect(running.progress!.omitted).toBe(2);
    expect(running.progress!.steps[0]!.text).toBe("Consulta tool_2");
    expect(running.progress!.steps.at(-1)!.status).toBe("running");
    expect(running.progress!.steps[0]!.status).toBe("done");
    expect(running.messages[0]!.run!.items).toEqual([{ number: 7, kind: "proposal", status: "pending", summary: "Crea la squadra" }]);

    await setRun(sent.runId, { status: "succeeded", output: "ok", costUsd: "0.010000", promptTokens: 10, completionTokens: 5 });
    const done = await getLeadConversation(me.userId, conv.id);
    expect(done.turnStatus).toBe("idle");
    expect(done.progress).toBeNull();
    expect(done.tokensUsed).toBe(15);
    expect(done.costUsd).toBeCloseTo(0.01);

    await db.delete(runsTable).where(eq(runsTable.id, sent.runId));
    const gone = await getLeadConversation(me.userId, conv.id);
    expect(gone.messages[0]!.run).toBeNull();
    expect(gone.turnStatus).toBe("idle");
  });

  it("eliminare la conversazione lascia le run", async () => {
    const me = await seedUser();
    await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    const sent = await sendLeadMessage(me.userId, conv.id, { content: "uno" });
    await deleteLeadConversation(me.userId, conv.id);
    expect(await db.select().from(leadConversationsTable)).toHaveLength(0);
    expect(await db.select().from(leadMessagesTable)).toHaveLength(0);
    expect(await db.select().from(runsTable).where(eq(runsTable.id, sent.runId))).toHaveLength(1);
    await expectError(deleteLeadConversation(me.userId, conv.id), 404, LEAD_CHAT_MESSAGES.notFound);
  });

  it("al più 100 conversazioni aperte", async () => {
    const me = await seedUser();
    const { lead } = await seedBotcave(me.modelId);
    await db.insert(leadConversationsTable).values(Array.from({ length: 100 }, () => ({ userId: me.userId, agentId: lead.id })));
    await expectError(createLeadConversation(me.userId), 409, LEAD_CHAT_MESSAGES.tooManyConversations);
  });

  it("al più 10 messaggi al minuto per utente", async () => {
    const me = await seedUser();
    await seedBotcave(me.modelId);
    const conv = await createLeadConversation(me.userId);
    for (let i = 0; i < 10; i++) {
      const sent = await sendLeadMessage(me.userId, conv.id, { content: `m${i}` });
      await setRun(sent.runId, { status: "succeeded", output: "ok" });
    }
    await expectError(sendLeadMessage(me.userId, conv.id, { content: "m10" }), 429, LEAD_CHAT_MESSAGES.tooMany);
  });
});
