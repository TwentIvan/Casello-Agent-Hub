import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, analysesTable, appsTable, type App } from "@workspace/db";
import { LOCAL_MODEL } from "../architect/local-executor";
import {
  REANALYSIS_MESSAGES,
  REANALYSIS_UNCLAIMED_MS,
  checkReanalysis,
  expireUnclaimedReanalyses,
  requestReanalysisCheck,
  runReanalysisRound,
  setReanalysisDepsForTests,
  waitReanalysisIdleForTests,
} from "./service";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
let currentSha = SHA;
let shaError = false;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

beforeEach(() => {
  currentSha = SHA;
  shaError = false;
  setReanalysisDepsForTests({
    readSha: async () => {
      if (shaError) throw new Error("GitHub non raggiungibile");
      return currentSha;
    },
  });
});

afterEach(async () => {
  await waitReanalysisIdleForTests();
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  setReanalysisDepsForTests(null);
  await pool.end();
});

async function insertApp(over: Partial<typeof appsTable.$inferInsert> = {}): Promise<App> {
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Fanta",
      slug: `fanta-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "http://localhost:1",
      sourceType: "github",
      sourceRepo: "ivan/fanta",
      sourceInstallationId: 77,
      autoReanalysis: true,
      ...over,
    })
    .returning();
  return app!;
}

async function reload(id: number): Promise<App> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id));
  return app!;
}

async function analysesOf(appId: number) {
  return db.select().from(analysesTable).where(eq(analysesTable.appId, appId));
}

async function insertCompleted(appId: number, sourceCommit: string | null) {
  await db.insert(analysesTable).values({
    appId,
    model: LOCAL_MODEL,
    executor: "local",
    status: "completed",
    sourceCommit,
    maxTokens: 1_000_000,
    sources: { code: "github", openapi: false, description: false },
    finishedAt: new Date(),
  });
}

describe("checkReanalysis", () => {
  it("ignora le App senza rianalisi automatica o senza GitHub tramite installazione", async () => {
    const off = await insertApp({ autoReanalysis: false });
    const manual = await insertApp({ sourceInstallationId: null });
    expect(await checkReanalysis(off)).toBe("not_eligible");
    expect(await checkReanalysis(manual)).toBe("not_eligible");
    expect(await analysesOf(off.id)).toHaveLength(0);
  });

  it("senza alcuna analisi lo SHA diventa la linea di partenza, poi un commit nuovo mette in coda l'analisi locale", async () => {
    const app = await insertApp();
    expect(await checkReanalysis(app)).toBe("baseline");
    expect((await reload(app.id)).reanalysisSeenSha).toBe(SHA);
    expect(await analysesOf(app.id)).toHaveLength(0);

    expect(await checkReanalysis(await reload(app.id))).toBe("unchanged");
    currentSha = SHA2;
    expect(await checkReanalysis(await reload(app.id))).toBe("queued");
    const [analysis] = await analysesOf(app.id);
    expect(analysis).toMatchObject({ executor: "local", status: "queued", triggerCommit: SHA2, aiModelId: null, mode: "full" });
    const after = await reload(app.id);
    expect(after.reanalysisSeenSha).toBe(SHA2);
    expect(after.reanalysisCheckedAt).not.toBeNull();
    // Stesso SHA: nessuna seconda analisi
    expect(await checkReanalysis(after)).toBe("unchanged");
    expect(await analysesOf(app.id)).toHaveLength(1);
  });

  it("al primo controllo confronta con il commit dell'ultima analisi conclusa", async () => {
    const same = await insertApp();
    await insertCompleted(same.id, SHA.toUpperCase());
    expect(await checkReanalysis(same)).toBe("unchanged");

    const behind = await insertApp();
    await insertCompleted(behind.id, SHA2);
    expect(await checkReanalysis(behind)).toBe("queued");
    expect((await analysesOf(behind.id)).find((a) => a.status === "queued")?.triggerCommit).toBe(SHA);
  });

  it("con un'analisi già aperta non segna lo SHA e riprova al controllo dopo", async () => {
    const app = await insertApp({ reanalysisSeenSha: SHA2 });
    await db.insert(analysesTable).values({
      appId: app.id,
      model: "m",
      status: "running",
      maxTokens: 1,
      sources: { code: "github", openapi: false, description: false },
    });
    expect(await checkReanalysis(app)).toBe("busy");
    expect((await reload(app.id)).reanalysisSeenSha).toBe(SHA2);
    await db.update(analysesTable).set({ status: "completed" }).where(eq(analysesTable.appId, app.id));
    expect(await checkReanalysis(await reload(app.id))).toBe("queued");
  });

  it("uno SHA non leggibile lascia tutto com'era", async () => {
    const app = await insertApp({ reanalysisSeenSha: SHA2 });
    shaError = true;
    expect(await checkReanalysis(app)).toBe("sha_error");
    const after = await reload(app.id);
    expect(after.reanalysisSeenSha).toBe(SHA2);
    expect(after.reanalysisCheckedAt).not.toBeNull();
    expect(await analysesOf(app.id)).toHaveLength(0);
  });
});

describe("giro e richieste", () => {
  it("il giro controlla solo le App idonee", async () => {
    const on = await insertApp({ reanalysisSeenSha: SHA2 });
    const off = await insertApp({ autoReanalysis: false, reanalysisSeenSha: SHA2 });
    expect(await runReanalysisRound()).toBe(1);
    expect(await analysesOf(on.id)).toHaveLength(1);
    expect(await analysesOf(off.id)).toHaveLength(0);
  });

  it("dopo un merge controlla subito, solo con la rianalisi accesa", async () => {
    const on = await insertApp({ reanalysisSeenSha: SHA2 });
    const off = await insertApp({ autoReanalysis: false, reanalysisSeenSha: SHA2 });
    requestReanalysisCheck(on.id);
    requestReanalysisCheck(off.id);
    requestReanalysisCheck(999_999);
    await waitReanalysisIdleForTests();
    expect(await analysesOf(on.id)).toHaveLength(1);
    expect(await analysesOf(off.id)).toHaveLength(0);
  });

  it("chiude le analisi automatiche mai prese in carico da oltre 24 ore, non quelle avviate a mano", async () => {
    const app = await insertApp();
    const old = new Date(Date.now() - REANALYSIS_UNCLAIMED_MS - 60_000);
    const base = { appId: app.id, model: LOCAL_MODEL, executor: "local" as const, maxTokens: 1, sources: { code: "github" as const, openapi: false, description: false } };
    const [auto] = await db.insert(analysesTable).values({ ...base, triggerCommit: SHA, createdAt: old }).returning();
    expect(await expireUnclaimedReanalyses()).toBe(1);
    const [closed] = await db.select().from(analysesTable).where(eq(analysesTable.id, auto!.id));
    expect(closed).toMatchObject({ status: "failed", error: REANALYSIS_MESSAGES.unclaimed });

    const other = await insertApp();
    await db.insert(analysesTable).values({ ...base, appId: other.id, createdAt: old });
    expect(await expireUnclaimedReanalyses()).toBe(0);
  });
});
