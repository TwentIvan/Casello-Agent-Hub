import { afterAll, describe, expect, it } from "vitest";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appArchitectureRunsTable,
  appsTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { agentSpends, modelSpends, userSpend } from "./budget";
import { encryptSecret } from "./secrets";

// Le generazioni della sintesi dell'architettura contano come le run: utente, modello, account e agente

process.env["CASELLO_SECRET_KEY"] ??= "d".repeat(64);

const LAST_MONTH = new Date(Date.now() - 40 * 24 * 3600 * 1000);
const THIS_MONTH = new Date(Date.now() - 60 * 1000);

async function setup() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const [user] = await db.insert(usersTable).values({ email: `arch-${rnd}@example.com` }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: user!.id,
      name: "Conto architettura",
      provider: "custom",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "m-arch", displayName: "Modello arch" })
    .returning();
  const [app] = await db
    .insert(appsTable)
    .values({ name: rnd, slug: `app-${rnd}`, description: "x", baseUrl: "http://app.example" })
    .returning();
  const [agent] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Resp", role: "general", status: "active", aiModelId: model!.id })
    .returning();
  return { userId: user!.id, modelId: model!.id, appId: app!.id, agentId: agent!.id };
}

const generation = (
  s: { userId: number; modelId: number; appId: number; agentId: number },
  extra: Partial<typeof appArchitectureRunsTable.$inferInsert>,
) =>
  db.insert(appArchitectureRunsTable).values({
    appId: s.appId,
    agentId: s.agentId,
    aiModelId: s.modelId,
    userId: s.userId,
    sha: "abc1234",
    createdAt: THIS_MONTH,
    ...extra,
  });

afterAll(async () => {
  await pool.end();
});

describe("sintesi dell'architettura nella spesa", () => {
  it("una run e una generazione dello stesso agente si sommano ovunque", async () => {
    const s = await setup();
    await db.insert(runsTable).values({
      agentId: s.agentId,
      aiModelId: s.modelId,
      input: "x",
      costUsd: "0.10",
      promptTokens: 10,
      completionTokens: 1,
      createdAt: THIS_MONTH,
    });
    await generation(s, { costUsd: "0.05", promptTokens: 10, completionTokens: 1 });
    expect((await agentSpends([s.agentId])).get(s.agentId)!.spentUsd).toBeCloseTo(0.15);
    expect((await userSpend(s.userId)).spentUsd).toBeCloseTo(0.15);
    expect((await modelSpends([s.modelId])).get(s.modelId)!.spentUsd).toBeCloseTo(0.15);
  });

  it("una generazione senza prezzo con token è non prezzata", async () => {
    const s = await setup();
    await generation(s, { costUsd: null, promptTokens: 100, completionTokens: 10 });
    expect((await userSpend(s.userId)).unpricedCount).toBe(1);
    expect((await agentSpends([s.agentId])).get(s.agentId)!.unpricedCount).toBe(1);
  });

  it("una generazione del mese scorso non conta", async () => {
    const s = await setup();
    await generation(s, { costUsd: "9", promptTokens: 10, completionTokens: 1, createdAt: LAST_MONTH });
    expect(await userSpend(s.userId)).toEqual({ spentUsd: 0, unpricedCount: 0 });
    expect((await agentSpends([s.agentId])).get(s.agentId)).toEqual({ spentUsd: 0, unpricedCount: 0 });
  });
});
