import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool, characterConversationsTable, characterMessagesTable, nodeTurnsTable } from "@workspace/db";
import { TurnBusyError } from "../plan-chat/run-turn";
import { trackTurn } from "../stale-turns";
import { seedNodeTurnSetup, samplePackage } from "../../../test/node-turn-fixture";
import { enqueueTurn } from "../node-turns/queue";
import type { PageContext } from "../characters/types";
import { closeTurnAsStopped, drainQueued, getQueued, queueChatMessage, stopChatTurn } from "./control";
import type { ChatKindSpec } from "./spec";

let userId: number;
let nodeId: number;
let aiModelId: number;
let conversationId: number;
let assistantId: number;
const started: Array<{ conversationId: number; content: string; page: PageContext | null }> = [];
let startImpl: (conversationId: number, content: string, page: PageContext | null) => Promise<{ id: number }>;

const spec: ChatKindSpec = {
  kind: "character",
  consumer: "character",
  conversationsTable: "character_conversations",
  messagesTable: "character_messages",
  hasPageContext: true,
  start: (id, content, page) => startImpl(id, content, page),
};

afterAll(async () => {
  await pool.query("TRUNCATE ai_accounts, users, nodes RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await pool.query("TRUNCATE ai_accounts, users, nodes RESTART IDENTITY CASCADE");
  started.length = 0;
  startImpl = async (id, content, page) => {
    started.push({ conversationId: id, content, page });
    return { id: 999 };
  };
  const setup = await seedNodeTurnSetup("ferma@x.it");
  userId = setup.userId;
  nodeId = setup.nodeId;
  aiModelId = setup.aiModelId;
  const [conv] = await db
    .insert(characterConversationsTable)
    .values({ userId, character: "lucius", subjectType: "skill", subjectId: "prova", title: "Prova", turnStatus: "running" })
    .returning();
  conversationId = conv!.id;
  await db.insert(characterMessagesTable).values({ conversationId, role: "user", content: "Ciao" });
  const [assistant] = await db.insert(characterMessagesTable).values({ conversationId, role: "assistant", content: "" }).returning();
  assistantId = assistant!.id;
});

const getConv = async () => (await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, conversationId)))[0]!;
const getMessage = async (id: number) => (await db.select().from(characterMessagesTable).where(eq(characterMessagesTable.id, id)))[0]!;
const queuedRows = () =>
  db
    .select()
    .from(characterMessagesTable)
    .where(and(eq(characterMessagesTable.conversationId, conversationId), isNotNull(characterMessagesTable.queuedAt)));

describe("stop e coda comuni alle chat", () => {
  it("closeTurnAsStopped chiude una volta sola", async () => {
    expect(await closeTurnAsStopped(spec, conversationId)).toBe(true);
    expect((await getConv()).turnStatus).toBe("idle");
    expect(await getMessage(assistantId)).toMatchObject({ content: "Risposta interrotta.", error: false });
    expect(await closeTurnAsStopped(spec, conversationId)).toBe(false);
  });

  it("closeTurnAsStopped annulla i turni del nodo aperti della conversazione", async () => {
    const { turnId } = await enqueueTurn({ nodeId, userId, aiModelId, consumer: "character", refId: conversationId, pkg: samplePackage() });
    const { turnId: other } = await enqueueTurn({ nodeId, userId, aiModelId, consumer: "plan_chat", refId: conversationId, pkg: samplePackage() });
    await closeTurnAsStopped(spec, conversationId);
    const [row] = await db.select().from(nodeTurnsTable).where(eq(nodeTurnsTable.id, turnId));
    expect(row!.status).toBe("cancelled");
    const [untouched] = await db.select().from(nodeTurnsTable).where(eq(nodeTurnsTable.id, other));
    expect(untouched!.status).toBe("queued");
  });

  it("queueChatMessage sostituisce il testo e conserva queued_at", async () => {
    const first = await queueChatMessage(spec, conversationId, "Primo", { page: "dashboard" });
    const [before] = await queuedRows();
    await new Promise((r) => setTimeout(r, 20));
    const second = await queueChatMessage(spec, conversationId, "Secondo", { page: "teams" });
    const rows = await queuedRows();
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("Secondo");
    expect(second.createdAt).toBeInstanceOf(Date);
    expect(rows[0]!.queuedAt!.getTime()).toBe(before!.queuedAt!.getTime());
    expect(rows[0]!.pageContext).toEqual({ page: "teams" });
    expect(await getQueued(spec, conversationId)).toMatchObject({ id: first.id, content: "Secondo" });
  });

  it("drainQueued avvia e toglie la riga", async () => {
    await queueChatMessage(spec, conversationId, "In coda", { page: "dashboard" });
    await drainQueued(spec, conversationId);
    expect(started).toEqual([{ conversationId, content: "In coda", page: { page: "dashboard" } }]);
    expect(await queuedRows()).toHaveLength(0);
    expect(await getQueued(spec, conversationId)).toBeNull();
  });

  it("drainQueued con start che lancia TurnBusyError lascia la riga", async () => {
    startImpl = async () => {
      throw new TurnBusyError();
    };
    await queueChatMessage(spec, conversationId, "In coda", null);
    await drainQueued(spec, conversationId);
    expect(await queuedRows()).toHaveLength(1);
  });

  it("drainQueued con un errore inatteso lascia la riga e non lancia", async () => {
    startImpl = async () => {
      throw new Error("boom");
    };
    await queueChatMessage(spec, conversationId, "In coda", null);
    await expect(drainQueued(spec, conversationId)).resolves.toBeUndefined();
    expect(await queuedRows()).toHaveLength(1);
  });

  it("drainQueued senza coda non chiama start", async () => {
    await drainQueued(spec, conversationId);
    expect(started).toHaveLength(0);
  });

  it("stopChatTurn con turno vivo in questo processo", async () => {
    const turn = trackTurn("character", conversationId, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await db.update(characterMessagesTable).set({ content: "Risposta interrotta." }).where(eq(characterMessagesTable.id, assistantId));
      await db.update(characterConversationsTable).set({ turnStatus: "idle" }).where(eq(characterConversationsTable.id, conversationId));
    });
    const t0 = Date.now();
    expect(await stopChatTurn(spec, conversationId)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await turn;
    expect((await getConv()).turnStatus).toBe("idle");
  });

  it("stopChatTurn su turno non vivo chiude nel DB e avvia la coda", async () => {
    await queueChatMessage(spec, conversationId, "Dopo", null);
    expect(await stopChatTurn(spec, conversationId)).toBe(true);
    expect(await getMessage(assistantId)).toMatchObject({ content: "Risposta interrotta." });
    expect(started).toHaveLength(1);
  });

  it("stopChatTurn su turno non in corso → false", async () => {
    await closeTurnAsStopped(spec, conversationId);
    expect(await stopChatTurn(spec, conversationId)).toBe(false);
  });
});
