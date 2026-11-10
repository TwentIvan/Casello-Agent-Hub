import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, modelOffersTable, modelsTable, nodesTable, usersTable } from "@workspace/db";
import { ensureProviderRegistry } from "../catalog/provider-registry";
import { NODE_MODEL_ALIASES, NODE_PROVIDER, nodeAccountModels, nodeTurnReady } from "./node-account";
import { verifyAccount } from "./accounts";

beforeEach(async () => {
  await pool.query("TRUNCATE users, ai_accounts, models, model_offers RESTART IDENTITY CASCADE");
  await ensureProviderRegistry();
});

async function offer(providerModelId: string, status: "available" | "retired"): Promise<void> {
  const [m] = await db.insert(modelsTable).values({ canonicalKey: providerModelId, author: "anthropic", family: "claude", version: providerModelId }).returning();
  await db.insert(modelOffersTable).values({ modelId: m!.id, provider: "anthropic", providerModelId, status });
}

describe("nodeAccountModels", () => {
  it("alias più offerte anthropic non ritirate, senza prezzi", async () => {
    await offer("claude-sonnet-5-5", "available");
    await offer("claude-old-1", "retired");
    const models = await nodeAccountModels();
    expect(models.map((m) => m.modelId)).toEqual([...NODE_MODEL_ALIASES, "claude-sonnet-5-5"]);
    expect(models[0]).toMatchObject({ modelId: "fable", displayName: "fable (ultimo)", priceInput: null, priceOutput: null, priceSource: null });
    expect(models.every((m) => m.priceCachedInput === null && m.contextTokens === null)).toBe(true);
  });
});

describe("nodeTurnReady", () => {
  const now = new Date("2026-11-09T10:00:00Z");
  it("pronto entro 60 s, non oltre né se disattivato o mai sondato", () => {
    expect(nodeTurnReady({ status: "active", lastTurnPollAt: new Date(now.getTime() - 59_000) }, now)).toBe(true);
    expect(nodeTurnReady({ status: "active", lastTurnPollAt: new Date(now.getTime() - 61_000) }, now)).toBe(false);
    expect(nodeTurnReady({ status: "disabled", lastTurnPollAt: new Date(now.getTime() - 1_000) }, now)).toBe(false);
    expect(nodeTurnReady({ status: "active", lastTurnPollAt: null }, now)).toBe(false);
  });
});

describe("provider nodo", () => {
  it("il registro scrive la riga managed", async () => {
    const { providersTable } = await import("@workspace/db");
    const [row] = await db.select().from(providersTable).where(eq(providersTable.slug, NODE_PROVIDER));
    expect(row).toMatchObject({ protocol: "claude_code_node", status: "managed", defaultBaseUrl: null, origin: "registry" });
  });
});

describe("verifyAccount su un account nodo", () => {
  async function seedAccount(withNode: boolean, lastPoll: Date | null) {
    const [u] = await db.insert(usersTable).values({ email: "a@example.com" }).returning();
    let nodeId: number | null = null;
    if (withNode) {
      const [n] = await db.insert(nodesTable).values({ userId: u!.id, name: "mac", lastTurnPollAt: lastPoll }).returning();
      nodeId = n!.id;
    }
    const [acc] = await db
      .insert(aiAccountsTable)
      .values({ userId: u!.id, name: "Nodo", provider: NODE_PROVIDER, baseUrl: "", apiKeyEnc: null, nodeId })
      .returning();
    return acc!;
  }

  it("nodo attivo mai collegato (o Mac in stop) → ok: la prontezza si mostra a parte; modelli scritti con strumenti", async () => {
    const acc = await seedAccount(true, null);
    const models = await verifyAccount(acc);
    expect(models).not.toBeNull();
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(after).toMatchObject({ status: "ok", lastError: null });
    const rows = await db.select().from(aiModelsTable).where(eq(aiModelsTable.accountId, acc.id));
    expect(rows.map((r) => r.modelId)).toEqual(expect.arrayContaining([...NODE_MODEL_ALIASES]));
    expect(rows.every((r) => r.supportsTools === true)).toBe(true);
  });

  it("nodo pronto → ok", async () => {
    const acc = await seedAccount(true, new Date());
    await verifyAccount(acc);
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(after).toMatchObject({ status: "ok", lastError: null });
  });

  it("nodo disattivato → error «nodo disattivato»", async () => {
    const acc = await seedAccount(true, new Date());
    await db.update(nodesTable).set({ status: "disabled" }).where(eq(nodesTable.id, acc.nodeId!));
    await verifyAccount(acc);
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(after).toMatchObject({ status: "error", lastError: "nodo disattivato" });
  });

  it("nodo eliminato → error «nodo eliminato»", async () => {
    const acc = await seedAccount(false, null);
    await verifyAccount(acc);
    const [after] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, acc.id));
    expect(after).toMatchObject({ status: "error", lastError: "nodo eliminato" });
  });
});
