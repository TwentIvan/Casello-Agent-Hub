import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  alfredSessionsTable,
  analysesTable,
  appsTable,
  characterConversationsTable,
  characterHistoryTable,
  planConversationsTable,
  teamChatConversationsTable,
  teamInstancesTable,
  usersTable,
} from "@workspace/db";
import { characterBudgetBlock, characterSpend, userSpend } from "./budget";
import { characterModelFor } from "./characters/settings";
import { encryptSecret } from "./secrets";

// Spesa e tetti per personaggio (Alfred, Lucius)

process.env["CASELLO_SECRET_KEY"] ??= "d".repeat(64);

async function setup() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const [user] = await db.insert(usersTable).values({ email: `char-${rnd}@example.com` }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: user!.id, name: "Conto", provider: "custom", baseUrl: "https://api.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: `m-${rnd}`, displayName: "Modello" }).returning();
  const [app] = await db
    .insert(appsTable)
    .values({ name: rnd, slug: `app-${rnd}`, description: "x", baseUrl: "http://app.example" })
    .returning();
  const [team] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "wi · 1" })
    .returning();
  return { userId: user!.id, accountId: account!.id, modelId: model!.id, appId: app!.id, teamId: team!.id };
}

const conv = (userId: number, modelId: number, character: "alfred" | "lucius", cost: string | null, tokens = 100) =>
  db.insert(characterConversationsTable).values({
    userId,
    character,
    subjectType: character === "alfred" ? "alfred_thread" : "agent",
    subjectId: character === "alfred" ? null : "1",
    aiModelId: modelId,
    title: "t",
    costUsd: cost,
    tokensUsed: tokens,
  });

const hist = (userId: number, modelId: number, character: "alfred" | "lucius", cost: string, extra: object = {}) =>
  db.insert(characterHistoryTable).values({
    userId,
    character,
    kind: character === "alfred" ? "alfred_session" : "team_chat",
    refId: Math.floor(Math.random() * 1e6),
    title: "t",
    summary: "s",
    aiModelId: modelId,
    tokensUsed: 10,
    costUsd: cost,
    ...extra,
  });

afterAll(async () => {
  await pool.end();
});

describe("spesa per personaggio", () => {
  it("character_spend_alfred_sources", async () => {
    const { userId, modelId } = await setup();
    await db.insert(alfredSessionsTable).values({ userId, aiModelId: modelId, costUsd: "0.10", promptTokens: 10, completionTokens: 10 });
    await conv(userId, modelId, "alfred", "0.20");
    await hist(userId, modelId, "alfred", "0.05");
    await conv(userId, modelId, "lucius", "9");
    expect((await characterSpend(userId, "alfred")).spentUsd).toBeCloseTo(0.35);
  });

  it("character_spend_lucius_sources", async () => {
    const { userId, modelId, appId, teamId } = await setup();
    const [analysis] = await db
      .insert(analysesTable)
      .values({ appId, aiModelId: modelId, model: "m", sources: {}, maxTokens: 1000, tokensUsed: 10, costUsd: "9" } as never)
      .returning();
    await db.insert(planConversationsTable).values({ appId, analysisId: analysis!.id, userId, aiModelId: modelId, title: "p", costUsd: "0.10", tokensUsed: 10 });
    await db.insert(teamChatConversationsTable).values({ teamInstanceId: teamId, userId, aiModelId: modelId, title: "t", costUsd: "0.20", tokensUsed: 10 });
    await conv(userId, modelId, "lucius", "0.30");
    await hist(userId, modelId, "lucius", "0.05");
    await conv(userId, modelId, "alfred", "9");
    expect((await characterSpend(userId, "lucius")).spentUsd).toBeCloseTo(0.65);
  });

  it("storico eliminato conta ancora; senza prezzo con token è non prezzato", async () => {
    const { userId, modelId } = await setup();
    await hist(userId, modelId, "alfred", "0.05", { deletedAt: new Date(), title: "", summary: "" });
    await conv(userId, modelId, "alfred", null, 10);
    expect(await characterSpend(userId, "alfred")).toEqual({ spentUsd: expect.closeTo(0.05), unpricedCount: 1 });
  });

  it("character_block_message", async () => {
    const { userId, modelId } = await setup();
    await conv(userId, modelId, "lucius", "0.65");
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0.50" }).where(eq(usersTable.id, userId));
    expect(await characterBudgetBlock(userId, "lucius", modelId)).toBe(
      "Tetto di spesa mensile di Lucius raggiunto: spesi 0,65 su 0,50 USD. Alzalo nella pagina Account o attendi il mese prossimo.",
    );
    expect(await characterBudgetBlock(userId, "alfred", modelId)).toBeNull();
  });

  it("character_block_order", async () => {
    const { userId, modelId } = await setup();
    await conv(userId, modelId, "lucius", "0.65");
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: "0.50", monthlyBudgetUsd: "0.10" }).where(eq(usersTable.id, userId));
    expect(await characterBudgetBlock(userId, "lucius", modelId)).toMatch(/^Tetto di spesa mensile di Lucius/);
    await db.update(usersTable).set({ luciusMonthlyBudgetUsd: null }).where(eq(usersTable.id, userId));
    expect(await characterBudgetBlock(userId, "lucius", modelId)).toMatch(/^Tetto di spesa mensile raggiunto/);
  });

  it("character_conversations_in_user_spend", async () => {
    const { userId, modelId } = await setup();
    await conv(userId, modelId, "alfred", "0.40");
    expect((await userSpend(userId)).spentUsd).toBeCloseTo(0.4);
  });

  it("model_for_falls_back_to_default", async () => {
    const { userId, modelId } = await setup();
    const other = await setup();
    // modello del personaggio di un altro utente: non è proprio, ripiega sul predefinito
    await db.update(usersTable).set({ luciusAiModelId: other.modelId, defaultAiModelId: modelId }).where(eq(usersTable.id, userId));
    expect(await characterModelFor(userId, "lucius")).toBe(modelId);
    await db.update(usersTable).set({ luciusAiModelId: modelId, defaultAiModelId: null }).where(eq(usersTable.id, userId));
    expect(await characterModelFor(userId, "lucius")).toBe(modelId);
    // account eliminato: modello sparito, ripiego null
    await db.delete(aiAccountsTable).where(eq(aiAccountsTable.userId, userId));
    expect(await characterModelFor(userId, "lucius")).toBeNull();
  });
});
