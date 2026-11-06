import { afterAll, describe, expect, it } from "vitest";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  characterHistoryTable,
  teamChatConversationsTable,
  teamInstancesTable,
  usersTable,
} from "@workspace/db";
import { accountSpends, modelSpends, userSpend } from "./budget";
import { encryptSecret } from "./secrets";

// Chat di squadra di Lucius e riassunti delle memorie contano nella spesa di utente, modello e account

process.env["CASELLO_SECRET_KEY"] ??= "d".repeat(64);

const LAST_MONTH = new Date(Date.now() - 40 * 24 * 3600 * 1000);

async function setup() {
  const [user] = await db
    .insert(usersTable)
    .values({ email: `lucius-${Math.random().toString(36).slice(2, 8)}@example.com` })
    .returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: user!.id,
      name: "Conto Lucius",
      provider: "custom",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "m-lucius", displayName: "Modello Lucius" })
    .returning();
  const slug = `app-${Math.random().toString(36).slice(2, 8)}`;
  const [app] = await db
    .insert(appsTable)
    .values({ name: slug, slug, description: "x", baseUrl: "http://app.example" })
    .returning();
  const [team] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra", refAppId: app!.id, refType: "wi", refId: "1", refTitle: "wi · 1" })
    .returning();
  return { userId: user!.id, accountId: account!.id, modelId: model!.id, teamId: team!.id };
}

afterAll(async () => {
  await pool.end();
});

describe("chat di squadra e storico nella spesa", () => {
  it("una conversazione da 0,5 e un riassunto da 0,01 sommano 0,51 per utente, modello e account", async () => {
    const { userId, accountId, modelId, teamId } = await setup();
    await db.insert(teamChatConversationsTable).values({
      teamInstanceId: teamId,
      userId,
      aiModelId: modelId,
      title: "t",
      costUsd: "0.5",
      tokensUsed: 100,
    });
    await db.insert(characterHistoryTable).values({
      userId,
      character: "lucius",
      kind: "team_chat",
      refId: 1,
      title: "t",
      summary: "s",
      aiModelId: modelId,
      tokensUsed: 50,
      costUsd: "0.01",
    });
    expect((await userSpend(userId)).spentUsd).toBeCloseTo(0.51);
    expect((await modelSpends([modelId])).get(modelId)!.spentUsd).toBeCloseTo(0.51);
    expect((await accountSpends([accountId])).get(accountId)!.spentUsd).toBeCloseTo(0.51);
  });

  it("senza prezzo con token conta tra le non prezzate; senza token no", async () => {
    const { userId, modelId, teamId } = await setup();
    await db.insert(teamChatConversationsTable).values({ teamInstanceId: teamId, userId, aiModelId: modelId, title: "a", costUsd: null, tokensUsed: 10 });
    await db.insert(teamChatConversationsTable).values({ teamInstanceId: teamId, userId, aiModelId: modelId, title: "b", costUsd: null, tokensUsed: 0 });
    await db.insert(characterHistoryTable).values({ userId, character: "alfred", kind: "alfred_session", refId: 1, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 5, costUsd: null });
    await db.insert(characterHistoryTable).values({ userId, character: "alfred", kind: "alfred_session", refId: 2, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 0, costUsd: null });
    expect(await userSpend(userId)).toEqual({ spentUsd: 0, unpricedCount: 2 });
  });

  it("voci del mese scorso non contano", async () => {
    const { userId, modelId, teamId } = await setup();
    await db.insert(teamChatConversationsTable).values({ teamInstanceId: teamId, userId, aiModelId: modelId, title: "a", costUsd: "9", tokensUsed: 10, updatedAt: LAST_MONTH });
    await db.insert(characterHistoryTable).values({ userId, character: "lucius", kind: "team_chat", refId: 1, title: "t", summary: "s", aiModelId: modelId, tokensUsed: 5, costUsd: "9", createdAt: LAST_MONTH });
    expect(await userSpend(userId)).toEqual({ spentUsd: 0, unpricedCount: 0 });
  });
});
