import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, agentsTable, aiAccountsTable, aiModelsTable, appsTable, modelOffersTable, modelsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import { deprecatesSoon, findDeprecatingAgents, pickReplacement, type ReplacementCandidate } from "./agent-deprecations";

// Agenti con il modello in dismissione (issue #114): regola del sostituto e lettura dal DB

process.env["CASELLO_SECRET_KEY"] ??= "d".repeat(64);

const NOW = new Date("2026-11-24T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function candidate(over: Partial<ReplacementCandidate> = {}): ReplacementCandidate {
  return {
    id: 2,
    name: "Economico",
    accountName: "Conto",
    modelId: "economico",
    priceInput: 0.1,
    priceOutput: 0.2,
    status: "available",
    supportsTools: true,
    deprecationDate: null,
    node: false,
    ...over,
  };
}

describe("deprecatesSoon", () => {
  it("entro 30 giorni o già passata; oltre o senza data no", () => {
    expect(deprecatesSoon(new Date(NOW.getTime() + 30 * DAY), NOW)).toBe(true);
    expect(deprecatesSoon(new Date(NOW.getTime() - DAY), NOW)).toBe(true);
    expect(deprecatesSoon(new Date(NOW.getTime() + 31 * DAY), NOW)).toBe(false);
    expect(deprecatesSoon(null, NOW)).toBe(false);
  });
});

describe("pickReplacement", () => {
  it("il più economico con strumenti, diverso dal modello attuale", () => {
    const r = pickReplacement(
      [candidate({ id: 1, priceInput: 0 }), candidate({ id: 3, name: "Caro", priceInput: 5 }), candidate()],
      1,
      NOW,
    );
    expect(r).toEqual({ aiModelId: 2, name: "Economico", accountName: "Conto", priceInput: 0.1, priceOutput: 0.2 });
  });
  it("scarta senza strumenti, senza prezzi, anteprima, nodo, non disponibili, solo audio e in dismissione", () => {
    const excluded = [
      candidate({ id: 10, supportsTools: null }),
      candidate({ id: 11, supportsTools: false }),
      candidate({ id: 12, priceOutput: null }),
      candidate({ id: 13, modelId: "gemini-2.5-flash-preview" }),
      candidate({ id: 14, node: true }),
      candidate({ id: 15, status: "unavailable" }),
      candidate({ id: 16, status: "retired" }),
      candidate({ id: 17, modelId: "gemini-live-2.5" }),
      candidate({ id: 18, deprecationDate: new Date(NOW.getTime() + 10 * DAY) }),
    ];
    expect(pickReplacement(excluded, 1, NOW)).toBeNull();
    // Dismissione lontana: va bene
    expect(pickReplacement([candidate({ id: 19, deprecationDate: new Date(NOW.getTime() + 90 * DAY) })], 1, NOW)?.aiModelId).toBe(19);
  });
  it("a parità di prezzo vince il nome", () => {
    expect(pickReplacement([candidate({ id: 5, name: "B" }), candidate({ id: 6, name: "A" })], 1, NOW)?.aiModelId).toBe(6);
  });
});

describe("findDeprecatingAgents", () => {
  async function seed() {
    const rnd = Math.random().toString(36).slice(2, 8);
    const [owner] = await db.insert(usersTable).values({ email: `dep-${rnd}@example.com` }).returning();
    const [other] = await db.insert(usersTable).values({ email: `dep2-${rnd}@example.com` }).returning();
    const account = async (userId: number, name: string) =>
      (
        await db
          .insert(aiAccountsTable)
          .values({ userId, name, provider: "custom", baseUrl: "https://api.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
          .returning()
      )[0]!;
    const mine = await account(owner!.id, "Mio");
    const theirs = await account(other!.id, "Altro");
    const [catalogModel] = await db
      .insert(modelsTable)
      .values({ canonicalKey: `k-${rnd}`, author: "A", family: "F", version: "1" })
      .returning();
    const offer = async (id: string, over: Partial<typeof modelOffersTable.$inferInsert>) =>
      (
        await db
          .insert(modelOffersTable)
          .values({ modelId: catalogModel!.id, provider: "custom", providerModelId: `${id}-${rnd}`, supportsTools: true, ...over })
          .returning()
      )[0]!;
    const soon = await offer("soon", { status: "deprecated", deprecationDate: new Date(NOW.getTime() + 10 * DAY) });
    const far = await offer("far", { status: "deprecated", deprecationDate: new Date(NOW.getTime() + 90 * DAY) });
    const gone = await offer("gone", { status: "retired" });
    const ok = await offer("ok", {});
    const model = async (accountId: number, modelId: string, offerId: number | null, price: string | null) =>
      (
        await db
          .insert(aiModelsTable)
          .values({ accountId, modelId, displayName: modelId, offerId, priceInputPerMtok: price, priceOutputPerMtok: price })
          .returning()
      )[0]!;
    const mSoon = await model(mine.id, "soon", soon.id, "1");
    const mFar = await model(mine.id, "far", far.id, "1");
    const mGone = await model(theirs.id, "gone", gone.id, "1");
    const mCheap = await model(mine.id, "cheap", ok.id, "0.5");
    await model(mine.id, "pricey", ok.id, "3");
    const mOtherCheap = await model(theirs.id, "other-cheap", ok.id, "0.2");
    const [app] = await db.insert(appsTable).values({ name: `App ${rnd}`, slug: `dep-${rnd}`, description: "x", baseUrl: "http://app.example" }).returning();
    const agent = async (name: string, aiModelId: number | null) =>
      (await db.insert(agentsTable).values({ appId: app!.id, name, aiModelId }).returning())[0]!;
    const aSoon = await agent("Smistatore", mSoon.id);
    await agent("Lontano", mFar.id);
    const aGone = await agent("Archivista", mGone.id);
    await agent("Senza modello", null);
    await agent("Sano", mCheap.id);
    return { owner: owner!.id, other: other!.id, app: app!, aSoon, aGone, mSoon, mGone, mCheap, mOtherCheap };
  }

  beforeEach(async () => {
    await pool.query("DELETE FROM apps");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM apps");
    await pool.query("TRUNCATE ai_accounts, models RESTART IDENTITY CASCADE");
  });

  it("ritirati e in dismissione entro 30 giorni, con il sostituto tra i modelli del proprietario", async () => {
    const s = await seed();
    const items = await findDeprecatingAgents({ now: NOW });
    expect(items).toEqual([
      {
        agentId: s.aGone.id,
        agentName: "Archivista",
        appId: s.app.id,
        appName: s.app.name,
        aiModelId: s.mGone.id,
        modelName: "gone",
        ownerUserId: s.other,
        deprecationDate: null,
        retired: true,
        replacement: { aiModelId: s.mOtherCheap.id, name: "other-cheap", accountName: "Altro", priceInput: 0.2, priceOutput: 0.2 },
      },
      {
        agentId: s.aSoon.id,
        agentName: "Smistatore",
        appId: s.app.id,
        appName: s.app.name,
        aiModelId: s.mSoon.id,
        modelName: "soon",
        ownerUserId: s.owner,
        deprecationDate: new Date(NOW.getTime() + 10 * DAY).toISOString().slice(0, 10),
        retired: false,
        replacement: { aiModelId: s.mCheap.id, name: "cheap", accountName: "Mio", priceInput: 0.5, priceOutput: 0.5 },
      },
    ]);
  });

  it("con candidatesFor il sostituto viene dai modelli di quell'utente", async () => {
    const s = await seed();
    const items = await findDeprecatingAgents({ now: NOW, candidatesFor: s.owner });
    expect(items.map((i) => i.replacement?.aiModelId)).toEqual([s.mCheap.id, s.mCheap.id]);
  });

  it("nessun agente con il modello in dismissione: lista vuota", async () => {
    expect(await findDeprecatingAgents({ now: NOW })).toEqual([]);
  });
});
