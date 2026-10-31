import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, modelOffersTable, modelsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import { upsertDiscovered } from "./accounts";

// Account "personalizzato" che punta all'indirizzo predefinito di un provider gestito (es. Gemini): alla lettura
// dei modelli diventa quel provider, così i modelli si abbinano al catalogo (prezzi e strumenti).

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
let userId: number;

async function cleanup() {
  await pool.query("TRUNCATE users, ai_accounts RESTART IDENTITY CASCADE");
  await pool.query("DELETE FROM model_offers");
  await pool.query("DELETE FROM models");
}

beforeEach(async () => {
  await cleanup();
  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com" }).returning();
  userId = user!.id;
  const [model] = await db
    .insert(modelsTable)
    .values({ canonicalKey: "gemini-2.5-flash", author: "google", family: "Gemini", version: "2.5 Flash" })
    .returning();
  await db.insert(modelOffersTable).values({
    modelId: model!.id,
    provider: "gemini",
    providerModelId: "gemini-2.5-flash",
    supportsTools: true,
    priceInputPerMtok: "0.3",
    priceOutputPerMtok: "2.5",
  });
});

const savedKey = process.env["CASELLO_SECRET_KEY"];
beforeAll(() => {
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
});
afterAll(async () => {
  await cleanup();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

async function customAccount(over: Partial<typeof aiAccountsTable.$inferInsert> = {}) {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Google", provider: "custom", baseUrl: GEMINI_URL, apiKeyEnc: encryptSecret("k"), status: "ok", ...over })
    .returning();
  return account!;
}

async function discover(accountId: number) {
  await db.transaction((tx) =>
    upsertDiscovered(tx, accountId, [
      { modelId: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", contextTokens: null, priceInput: null, priceOutput: null, priceCachedInput: null, priceSource: null },
    ]),
  );
  const [account] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, accountId));
  const [model] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, accountId));
  return { account: account!, model: model! };
}

describe("account personalizzato con l'indirizzo di un provider gestito", () => {
  it("diventa quel provider e i modelli prendono prezzi e strumenti dal catalogo", async () => {
    const { account, model } = await discover((await customAccount({ baseUrl: `${GEMINI_URL}/` })).id);
    expect(account.provider).toBe("gemini");
    expect(model).toMatchObject({ supportsTools: true, priceInputPerMtok: "0.300000", priceOutputPerMtok: "2.500000", priceSource: "catalog" });
    expect(model.offerId).not.toBeNull();
  });

  it("resta personalizzato con un indirizzo diverso, con la rete privata consentita o senza chiave", async () => {
    for (const over of [
      { baseUrl: "https://llm.example.com/v1" },
      { allowPrivateNetwork: true },
      { apiKeyEnc: null },
    ]) {
      const { account, model } = await discover((await customAccount(over)).id);
      expect(account.provider, JSON.stringify(over)).toBe("custom");
      expect(model.offerId).toBeNull();
    }
  });
});
