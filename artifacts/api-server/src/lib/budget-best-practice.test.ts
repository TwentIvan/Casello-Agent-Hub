import { afterAll, describe, expect, it } from "vitest";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  appsTable,
  bestPracticeSearchesTable,
  usersTable,
} from "@workspace/db";
import { accountSpends, characterSpend, modelSpends, userSpend } from "./budget";
import { encryptSecret } from "./secrets";

// Le ricerche di best practice di Lucius contano nella spesa; quelle legate a un'analisi no (contano nell'analisi)

process.env["CASELLO_SECRET_KEY"] ??= "d".repeat(64);

async function setup() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const [user] = await db.insert(usersTable).values({ email: `bpb-${rnd}@example.com` }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: user!.id, name: "Conto bp", provider: "custom", baseUrl: "https://api.example.com/v1", apiKeyEnc: encryptSecret("k"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m-bp", displayName: "M" }).returning();
  const [app] = await db.insert(appsTable).values({ name: rnd, slug: `bp-${rnd}`, description: "x", baseUrl: "http://app.example" }).returning();
  const [analysis] = await db.insert(analysesTable).values({ appId: app!.id, model: "m", sources: {}, maxTokens: 1000 } as never).returning();
  return { userId: user!.id, accountId: account!.id, modelId: model!.id, analysisId: analysis!.id };
}

const search = (s: Awaited<ReturnType<typeof setup>>, extra: Partial<typeof bestPracticeSearchesTable.$inferInsert>) =>
  db.insert(bestPracticeSearchesTable).values({
    userId: s.userId,
    queryHash: "h",
    query: "q",
    answer: "a",
    aiModelId: s.modelId,
    promptTokens: 10,
    completionTokens: 5,
    costUsd: "0.20",
    ...extra,
  });

afterAll(async () => {
  await pool.query("DELETE FROM apps WHERE slug LIKE 'bp-%'");
  await pool.query("DELETE FROM users WHERE email LIKE 'bpb-%@example.com'");
  await pool.end();
});

describe("ricerche di best practice nella spesa", () => {
  it("una ricerca senza analisi conta per Lucius, utente, modello e account", async () => {
    const s = await setup();
    await search(s, {});
    expect((await characterSpend(s.userId, "lucius")).spentUsd).toBeCloseTo(0.2);
    expect((await userSpend(s.userId)).spentUsd).toBeCloseTo(0.2);
    expect((await modelSpends([s.modelId])).get(s.modelId)!.spentUsd).toBeCloseTo(0.2);
    expect((await accountSpends([s.accountId])).get(s.accountId)!.spentUsd).toBeCloseTo(0.2);
  });
  it("una ricerca legata a un'analisi non conta", async () => {
    const s = await setup();
    await search(s, { analysisId: s.analysisId });
    expect((await characterSpend(s.userId, "lucius")).spentUsd).toBe(0);
    expect((await userSpend(s.userId)).spentUsd).toBe(0);
    expect((await modelSpends([s.modelId])).get(s.modelId)!.spentUsd).toBe(0);
    expect((await accountSpends([s.accountId])).get(s.accountId)!.spentUsd).toBe(0);
  });
  it("Alfred non la conta", async () => {
    const s = await setup();
    await search(s, {});
    expect((await characterSpend(s.userId, "alfred")).spentUsd).toBe(0);
  });
  it("senza prezzo ma con token è non prezzata", async () => {
    const s = await setup();
    await search(s, { costUsd: null });
    expect((await characterSpend(s.userId, "lucius")).unpricedCount).toBe(1);
    expect((await userSpend(s.userId)).unpricedCount).toBe(1);
  });
});
