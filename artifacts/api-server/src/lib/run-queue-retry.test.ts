import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, appsTable, agentsTable, runsTable } from "@workspace/db";

// startRun finto che fallisce: la run resta `pending` e il giro successivo la riprenderebbe subito.
const startRun = vi.hoisted(() => vi.fn(async (_runId: number) => {
  throw new Error("boom");
}));
vi.mock("./run-executor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-executor")>()),
  startRun,
}));

import { startRunQueue } from "./run-queue";
import { logger } from "./logger";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

let stopQueue: (() => void) | null = null;

beforeEach(async () => {
  startRun.mockClear();
  vi.spyOn(logger, "error").mockImplementation(() => logger);
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  stopQueue?.();
  stopQueue = null;
  await pool.query(`update runs set status = 'cancelled'`);
  await pause(1_200);
  vi.restoreAllMocks();
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

describe("errore di startRun", () => {
  it("il giro successivo parte dopo un breve ritardo, non subito", async () => {
    const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" }).returning();
    const [agent] = await db
      .insert(agentsTable)
      .values({ appId: app!.id, name: "Area", role: "area", status: "active", model: "m" })
      .returning();
    await db.insert(runsTable).values({ agentId: agent!.id, input: "x" });

    stopQueue = startRunQueue();
    await pause(300);
    // Senza ritardo il giro ripartirebbe a ogni errore: decine di chiamate in 300 ms
    expect(startRun).toHaveBeenCalledTimes(1);

    await pause(1_000);
    expect(startRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(startRun.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
