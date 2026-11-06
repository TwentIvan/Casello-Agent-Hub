import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, agentsTable, appsTable, characterConversationsTable, characterMessagesTable, characterProposalsTable, usersTable } from "@workspace/db";
import { HANDOFF_TOOL, runHandoff } from "./handoff";
import { createTurnContext } from "./proposals";
import { registerSubject } from "./registry";
import { toolOk, type SubjectHandler, type TurnContext } from "./types";

// Argomenti finti: `agent` di Lucius risolto sul DB, il filo di Alfred sempre presente
const agentSubject: SubjectHandler = {
  character: "lucius",
  type: "agent",
  resolve: async (_userId, subjectId) => {
    if (subjectId === null || !/^\d+$/.test(subjectId)) return null;
    const [a] = await db.select({ name: agentsTable.name }).from(agentsTable).where(eq(agentsTable.id, Number(subjectId)));
    return a ? { title: a.name } : null;
  },
  context: async () => [],
  tools: [],
  runTool: async () => toolOk(null),
};
const alfredThread: SubjectHandler = {
  character: "alfred",
  type: "alfred_thread",
  resolve: async (_userId, subjectId) => (subjectId === null ? { title: "Filo di Alfred" } : null),
  context: async () => [],
  tools: [],
  runTool: async () => toolOk(null),
};

let restore: Array<() => void> = [];
let userId: number;
let appId: number;
let agentId: number;
let alfredCtx: TurnContext;
let luciusCtx: TurnContext;

beforeAll(() => {
  restore = [registerSubject(agentSubject), registerSubject(alfredThread)];
});
afterAll(async () => {
  for (const r of restore) r();
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
});

async function contextFor(character: "alfred" | "lucius", subjectType: string, subjectId: string | null): Promise<TurnContext> {
  const [conv] = await db.insert(characterConversationsTable).values({ userId, character, subjectType, subjectId, title: "" }).returning();
  const [msg] = await db.insert(characterMessagesTable).values({ conversationId: conv!.id, role: "assistant", content: "" }).returning();
  return createTurnContext({ userId, conversationId: conv!.id, messageId: msg!.id, subjectId });
}

beforeEach(async () => {
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "a@x.it" }).returning();
  userId = user!.id;
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example" }).returning();
  appId = app!.id;
  const [agent] = await db.insert(agentsTable).values({ appId, name: "Rose", role: "area" }).returning();
  agentId = agent!.id;
  alfredCtx = await contextFor("alfred", "alfred_thread", null);
  luciusCtx = await contextFor("lucius", "agent", String(agentId));
});

const proposals = () => db.select().from(characterProposalsTable);
const parse = (s: string) => JSON.parse(s) as { ok: boolean; result?: { id: number }; error?: string };

describe("passa_a", () => {
  it("lo strumento si chiama passa_a con argomento e domanda obbligatori", () => {
    expect(HANDOFF_TOOL.function.name).toBe("passa_a");
    expect(HANDOFF_TOOL.function.parameters).toMatchObject({ required: ["argomento", "domanda"] });
  });

  it("handoff_creates_card: Alfred → Lucius su un agente esistente", async () => {
    const r = parse(await runHandoff("alfred", { argomento: "agent", oggetto: String(agentId), domanda: "  Come migliorare il prompt di Rose?  " }, alfredCtx));
    expect(r.ok).toBe(true);
    const rows = await proposals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.result!.id,
      conversationId: alfredCtx.conversationId,
      messageId: alfredCtx.messageId,
      kind: "handoff",
      status: "pending",
      targetHash: null,
      payload: { to: "lucius", subjectType: "agent", subjectId: String(agentId), question: "Come migliorare il prompt di Rose?" },
    });
    expect(alfredCtx.proposalsLeft()).toBe(9);
  });

  it("verso Lucius anche plan (app esistente) e verso Alfred il filo", async () => {
    expect(parse(await runHandoff("alfred", { argomento: "plan", oggetto: String(appId), domanda: "Piano?" }, alfredCtx)).ok).toBe(true);
    expect(parse(await runHandoff("alfred", { argomento: "plan", oggetto: String(appId + 99), domanda: "Piano?" }, alfredCtx))).toEqual({
      ok: false,
      error: "argomento non trovato",
    });
    expect(parse(await runHandoff("alfred", { argomento: "team", oggetto: "12345", domanda: "Squadra?" }, alfredCtx)).ok).toBe(false);
    const r = parse(await runHandoff("lucius", { argomento: "alfred_thread", domanda: "Come va la squadra?" }, luciusCtx));
    expect(r.ok).toBe(true);
    const rows = await proposals();
    expect(rows.map((p) => p.payload)).toEqual([
      { to: "lucius", subjectType: "plan", subjectId: String(appId), question: "Piano?" },
      { to: "alfred", subjectType: "alfred_thread", subjectId: null, question: "Come va la squadra?" },
    ]);
  });

  it("handoff_rejects_unknown_subject: agente inesistente o argomento non dell'altro personaggio → ok: false, nessuna scheda", async () => {
    expect(parse(await runHandoff("alfred", { argomento: "agent", oggetto: String(agentId + 1), domanda: "Domanda" }, alfredCtx)).ok).toBe(false);
    // alfred_thread è di Alfred stesso, non dell'altro personaggio
    expect(parse(await runHandoff("alfred", { argomento: "alfred_thread", domanda: "Domanda" }, alfredCtx)).ok).toBe(false);
    // plan e team valgono solo verso Lucius
    expect(parse(await runHandoff("lucius", { argomento: "plan", oggetto: String(appId), domanda: "Domanda" }, luciusCtx)).ok).toBe(false);
    expect(parse(await runHandoff("lucius", { argomento: "agent", oggetto: String(agentId), domanda: "Domanda" }, luciusCtx)).ok).toBe(false);
    expect(parse(await runHandoff("alfred", { argomento: "inesistente", domanda: "Domanda" }, alfredCtx)).ok).toBe(false);
    expect(await proposals()).toHaveLength(0);
  });

  it("handoff_question_too_long: 2 001 caratteri → ok: false", async () => {
    const r = parse(await runHandoff("alfred", { argomento: "agent", oggetto: String(agentId), domanda: "x".repeat(2_001) }, alfredCtx));
    expect(r).toEqual({ ok: false, error: "la domanda supera 2000 caratteri" });
    expect(parse(await runHandoff("alfred", { argomento: "agent", oggetto: String(agentId), domanda: "   " }, alfredCtx)).ok).toBe(false);
    expect(await proposals()).toHaveLength(0);
  });
});
