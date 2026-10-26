import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, agentsTable, aiAccountsTable, aiModelsTable, analysesTable, appsTable } from "@workspace/db";
import { AVAILABLE_MODELS } from "../models";
import { ensureSystemAccount } from "./system-account";

const ENV_KEYS = ["AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let appId: number;

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AI_GATEWAY_BASE_URL"] = "https://gateway.example.test/v1";
  process.env["AI_GATEWAY_API_KEY"] = "sk-test-gateway";
  await pool.query("TRUNCATE apps, ai_accounts RESTART IDENTITY CASCADE");
  const [app] = await db.insert(appsTable).values({ name: "Fanta", slug: "fanta", baseUrl: "https://fanta.test" }).returning();
  appId = app!.id;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts RESTART IDENTITY CASCADE");
});

describe("ensureSystemAccount", () => {
  it("crea account di sistema e un modello per voce dell'elenco", async () => {
    const res = await ensureSystemAccount();
    expect(res).not.toBeNull();
    const accounts = await db.select().from(aiAccountsTable);
    expect(accounts).toHaveLength(1);
    const acc = accounts[0]!;
    expect(acc).toMatchObject({
      id: res!.accountId,
      name: "Gateway Casello",
      provider: "system_gateway",
      userId: null,
      apiKeyEnc: null,
      status: "ok",
      isDefault: false,
      baseUrl: "https://gateway.example.test/v1",
    });
    const models = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, acc.id));
    expect(models.map((m) => m.modelId).sort()).toEqual(AVAILABLE_MODELS.map((m) => m.id).sort());
    expect(models.every((m) => m.discovered === false)).toBe(true);
  });

  it("e' idempotente: la seconda chiamata non duplica", async () => {
    const a = await ensureSystemAccount();
    const b = await ensureSystemAccount();
    expect(b!.accountId).toBe(a!.accountId);
    expect(await db.select().from(aiAccountsTable)).toHaveLength(1);
    expect(await db.select().from(aiModelsTable)).toHaveLength(AVAILABLE_MODELS.length);
  });

  it("collega agenti e analisi esistenti al modello corrispondente", async () => {
    const [ag] = await db
      .insert(agentsTable)
      .values({ appId, name: "Generale", role: "general", model: "openrouter/deepseek-chat" })
      .returning();
    const [unk] = await db
      .insert(agentsTable)
      .values({ appId, name: "Strano", model: "modello/sconosciuto" })
      .returning();
    const [an] = await db
      .insert(analysesTable)
      .values({ appId, model: "openrouter/qwen3-235b", sources: { code: "none", openapi: false, description: false }, maxTokens: 1000 })
      .returning();
    const res = await ensureSystemAccount();
    const model = (await db.select().from(aiModelsTable).where(eq(aiModelsTable.modelId, "openrouter/deepseek-chat")))[0]!;
    const qwen = (await db.select().from(aiModelsTable).where(eq(aiModelsTable.modelId, "openrouter/qwen3-235b")))[0]!;
    expect(model.accountId).toBe(res!.accountId);
    expect((await db.select().from(agentsTable).where(eq(agentsTable.id, ag!.id)))[0]!.aiModelId).toBe(model.id);
    expect((await db.select().from(agentsTable).where(eq(agentsTable.id, unk!.id)))[0]!.aiModelId).toBeNull();
    expect((await db.select().from(analysesTable).where(eq(analysesTable.id, an!.id)))[0]!.aiModelId).toBe(qwen.id);
  });

  it("non sovrascrive un collegamento esistente ne' i prezzi manuali", async () => {
    await ensureSystemAccount();
    const m = (await db.select().from(aiModelsTable).where(eq(aiModelsTable.modelId, "openrouter/auto")))[0]!;
    await db.update(aiModelsTable).set({ priceInputPerMtok: "1.5", priceOutputPerMtok: "2", priceSource: "manual" }).where(eq(aiModelsTable.id, m.id));
    const other = (await db.select().from(aiModelsTable).where(eq(aiModelsTable.modelId, "openrouter/mistral-small")))[0]!;
    const [ag] = await db
      .insert(agentsTable)
      .values({ appId, name: "G", role: "general", model: "openrouter/auto", aiModelId: other.id })
      .returning();
    await ensureSystemAccount();
    const after = (await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, m.id)))[0]!;
    expect(after.priceSource).toBe("manual");
    expect(Number(after.priceInputPerMtok)).toBe(1.5);
    expect((await db.select().from(agentsTable).where(eq(agentsTable.id, ag!.id)))[0]!.aiModelId).toBe(other.id);
  });

  it("senza variabili restituisce null e non tocca nulla", async () => {
    delete process.env["AI_GATEWAY_API_KEY"];
    expect(await ensureSystemAccount()).toBeNull();
    delete process.env["AI_GATEWAY_BASE_URL"];
    process.env["AI_GATEWAY_API_KEY"] = "x";
    expect(await ensureSystemAccount()).toBeNull();
    expect(await db.select().from(aiAccountsTable)).toHaveLength(0);
    expect(await db.select().from(aiModelsTable)).toHaveLength(0);
  });
});
