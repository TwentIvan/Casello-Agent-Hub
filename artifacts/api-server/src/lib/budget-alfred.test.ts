import { afterAll, describe, expect, it } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, alfredSessionsTable, usersTable } from "@workspace/db";
import { accountSpends, modelSpends, userBudgetBlock, userSpend } from "./budget";
import { encryptSecret } from "./secrets";

// Le sessioni di Alfred contano nella spesa di utente, modello e account (stesso filtro delle conversazioni del piano)

process.env["CASELLO_SECRET_KEY"] ??= "d".repeat(64);

const LAST_MONTH = new Date(Date.now() - 40 * 24 * 3600 * 1000);

async function setup(modelCap: string | null = null) {
  const [user] = await db
    .insert(usersTable)
    .values({ email: `alfred-${Math.random().toString(36).slice(2, 8)}@example.com` })
    .returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: user!.id,
      name: "Conto Alfred",
      provider: "custom",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "m-alfred", displayName: "Modello Alfred", monthlyBudgetUsd: modelCap })
    .returning();
  return { userId: user!.id, accountId: account!.id, modelId: model!.id };
}

const session = (userId: number, aiModelId: number, extra: Partial<typeof alfredSessionsTable.$inferInsert>) =>
  db.insert(alfredSessionsTable).values({ userId, aiModelId, ...extra });

afterAll(async () => {
  await pool.end();
});

describe("sessioni di Alfred nella spesa", () => {
  it("una sessione prezzata entra in utente, modello e account", async () => {
    const { userId, accountId, modelId } = await setup();
    await session(userId, modelId, { costUsd: "1.5", promptTokens: 100, completionTokens: 10 });
    expect((await userSpend(userId)).spentUsd).toBeCloseTo(1.5);
    expect((await modelSpends([modelId])).get(modelId)!.spentUsd).toBeCloseTo(1.5);
    expect((await accountSpends([accountId])).get(accountId)!.spentUsd).toBeCloseTo(1.5);
  });

  it("una sessione senza prezzo con token conta tra le non prezzate; senza token no", async () => {
    const { userId, modelId } = await setup();
    await session(userId, modelId, { costUsd: null, promptTokens: 50, completionTokens: 5 });
    await session(userId, modelId, { costUsd: null, promptTokens: 0, completionTokens: 0 });
    const spend = await userSpend(userId);
    expect(spend.unpricedCount).toBe(1);
    expect(spend.spentUsd).toBe(0);
  });

  it("una sessione con ultima attività del mese scorso non conta", async () => {
    const { userId, modelId } = await setup();
    await session(userId, modelId, { costUsd: "9", promptTokens: 10, completionTokens: 1, lastActivityAt: LAST_MONTH });
    expect(await userSpend(userId)).toEqual({ spentUsd: 0, unpricedCount: 0 });
  });

  it("userBudgetBlock blocca quando la sessione supera il tetto del modello", async () => {
    const { userId, modelId } = await setup("1.00");
    expect(await userBudgetBlock(modelId)).toBeNull();
    await session(userId, modelId, { costUsd: "1.5", promptTokens: 100, completionTokens: 10 });
    expect(await userBudgetBlock(modelId)).toMatch(/Tetto di spesa mensile del modello "Modello Alfred" raggiunto/);
  });
});
