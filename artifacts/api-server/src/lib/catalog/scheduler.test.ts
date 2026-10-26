import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, catalogRunsTable, modelOffersTable, modelsTable } from "@workspace/db";
import { CatalogBusyError, type startCatalogRefresh } from "./refresh";
import { checkWeeklyRefresh, isWeeklyRefreshDue } from "./scheduler";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function fakeStart() {
  return vi.fn<typeof startCatalogRefresh>(async () => ({
    run: { id: 0, trigger: "scheduled", userId: null, status: "running", startedAt: NOW, finishedAt: null, summary: null, error: null },
    done: Promise.resolve(),
  }));
}

async function cleanup() {
  await pool.query("TRUNCATE catalog_runs RESTART IDENTITY");
  // DELETE e non TRUNCATE CASCADE: ai_models fa riferimento alle offerte (set null)
  await pool.query("DELETE FROM model_offers");
  await pool.query("DELETE FROM models");
}

/** Un'offerta qualsiasi: il catalogo non è vuoto. */
async function someOffer() {
  const [model] = await db.insert(modelsTable).values({ canonicalKey: "deepseek-chat", author: "DeepSeek", family: "DeepSeek", version: "chat" }).returning();
  await db.insert(modelOffersTable).values({ modelId: model!.id, provider: "deepseek", providerModelId: "deepseek-chat" });
}

beforeEach(cleanup);
afterAll(cleanup);

describe("isWeeklyRefreshDue", () => {
  it("dovuto senza esecuzioni o dopo più di 7 giorni", () => {
    expect(isWeeklyRefreshDue(null, NOW)).toBe(true);
    expect(isWeeklyRefreshDue(daysAgo(6), NOW)).toBe(false);
    expect(isWeeklyRefreshDue(daysAgo(8), NOW)).toBe(true);
  });
});

describe("checkWeeklyRefresh", () => {
  it("avvia l'aggiornamento pianificato se l'ultimo concluso ha più di 7 giorni", async () => {
    await db.insert(catalogRunsTable).values({ trigger: "manual", status: "completed", startedAt: daysAgo(8), finishedAt: daysAgo(8) });
    const start = fakeStart();
    expect(await checkWeeklyRefresh(NOW, start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ trigger: "scheduled", userId: null });
  });

  it("non avvia nulla se l'ultimo concluso è recente e ci sono offerte", async () => {
    await someOffer();
    await db.insert(catalogRunsTable).values({ trigger: "scheduled", status: "partial", startedAt: daysAgo(1), finishedAt: daysAgo(1) });
    const start = fakeStart();
    expect(await checkWeeklyRefresh(NOW, start)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("avvia se l'ultimo concluso è recente ma model_offers è vuota", async () => {
    await db.insert(catalogRunsTable).values({ trigger: "manual", status: "completed", startedAt: daysAgo(1), finishedAt: daysAgo(1) });
    const start = fakeStart();
    expect(await checkWeeklyRefresh(NOW, start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("un'esecuzione fallita recente non conta", async () => {
    await db.insert(catalogRunsTable).values([
      { trigger: "scheduled", status: "completed", startedAt: daysAgo(8), finishedAt: daysAgo(8) },
      { trigger: "manual", status: "failed", startedAt: daysAgo(1), finishedAt: daysAgo(1) },
    ]);
    const start = fakeStart();
    expect(await checkWeeklyRefresh(NOW, start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("un aggiornamento già in corso non è un errore", async () => {
    const start = vi.fn<typeof startCatalogRefresh>(async () => {
      throw new CatalogBusyError();
    });
    expect(await checkWeeklyRefresh(NOW, start)).toBe(false);
  });
});
