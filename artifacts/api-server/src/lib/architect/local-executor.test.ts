import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, analysesTable, analysisItemsTable, analysisPhaseResultsTable, appsTable } from "@workspace/db";
import {
  LOCAL_LEASE_MS,
  LOCAL_MODEL,
  LocalAnalysisError,
  abandonLocalAnalysis,
  cancelLocalAnalysis,
  claimLocalAnalysis,
  listOpenLocalAnalyses,
  localPhaseInstructions,
  pingLocalAnalysis,
  releaseExpiredLeases,
  releaseLocalAnalysis,
  setExpectedCommit,
  submitLocalPhase,
} from "./local-executor";
import { failInterruptedAnalyses } from "./run-analysis";
import { PHASE_EXAMPLES, SYSTEM_BASE } from "./prompts";
import { PHASES } from "./schemas";

// Ciclo di vita delle analisi eseguite da un agente locale: l'orologio arriva come `now`.

const T0 = new Date("2026-10-28T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let appId: number;
let analysisId: number;

async function newLocalAnalysis(): Promise<number> {
  const [row] = await db
    .insert(analysesTable)
    .values({
      appId,
      model: LOCAL_MODEL,
      aiModelId: null,
      executor: "local",
      sources: { code: "github", openapi: false, description: true },
      maxTokens: 1_000_000,
    })
    .returning();
  return row!.id;
}

const loadAnalysis = async (id = analysisId) => (await db.select().from(analysesTable).where(eq(analysesTable.id, id)))[0]!;
const loadItems = () => db.select().from(analysisItemsTable).where(eq(analysisItemsTable.analysisId, analysisId));

/** Errore atteso dell'agente locale, con il messaggio. */
async function expectLocalError(promise: Promise<unknown>, message: string | RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LocalAnalysisError);
  if (typeof message === "string") expect((err as Error).message).toBe(message);
  else expect((err as Error).message).toMatch(message);
}

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Fanta",
      slug: "fanta-locale",
      baseUrl: "http://127.0.0.1:1",
      functionalDescription: "Gestione del fantacalcio",
      sourceType: "github",
      sourceRepo: "ivan/fanta",
      sourceBranch: "main",
    })
    .returning();
  appId = app!.id;
  analysisId = await newLocalAnalysis();
});

afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

describe("claimLocalAnalysis", () => {
  it("prende l'analisi: running, fase map, lease di 15 minuti, scheda dell'app", async () => {
    const claim = await claimLocalAnalysis(analysisId, "Mac di Ivan", T0);
    expect(claim.phase).toBe("map");
    expect(claim.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(claim.app).toEqual({
      name: "Fanta",
      functionalDescription: "Gestione del fantacalcio",
      baseUrl: "http://127.0.0.1:1",
      sourceRepo: "ivan/fanta",
      sourceBranch: "main",
      hasOpenApi: false,
    });
    const row = await loadAnalysis();
    expect(row.status).toBe("running");
    expect(row.phase).toBe("map");
    expect(row.leaseLabel).toBe("Mac di Ivan");
    expect(row.leaseUntil!.getTime()).toBe(T0.getTime() + LOCAL_LEASE_MS);
    expect(LOCAL_LEASE_MS).toBe(900_000);
    // A riposo solo l'hash del token
    expect(row.leaseTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.leaseTokenHash).not.toBe(claim.leaseToken);
  });

  it("due claim concorrenti: uno solo riesce, l'altro trova l'analisi già presa", async () => {
    const results = await Promise.allSettled([
      claimLocalAnalysis(analysisId, "primo", T0),
      claimLocalAnalysis(analysisId, "secondo", T0),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0]!.reason).toBeInstanceOf(LocalAnalysisError);
    // 10:15 UTC = 11:15 a Roma (ora solare dal 25 ottobre)
    expect((ko[0]!.reason as Error).message).toMatch(/^analisi già presa da (primo|secondo) fino alle 11:15$/);
  });

  it("una lease scaduta si può riprendere; un'analisi chiusa o cloud no", async () => {
    await claimLocalAnalysis(analysisId, "primo", T0);
    await expectLocalError(claimLocalAnalysis(analysisId, "secondo", at(LOCAL_LEASE_MS - 1)), /^analisi già presa da primo/);
    const again = await claimLocalAnalysis(analysisId, "secondo", at(LOCAL_LEASE_MS + 1));
    expect(again.phase).toBe("map");
    expect((await loadAnalysis()).leaseLabel).toBe("secondo");

    await cancelLocalAnalysis(analysisId);
    await expectLocalError(claimLocalAnalysis(analysisId, "terzo", T0), "analisi non trovata o non tua");
    await expectLocalError(claimLocalAnalysis(9999, "terzo", T0), "analisi non trovata o non tua");

    const [cloud] = await db
      .insert(analysesTable)
      .values({ appId, model: "openrouter/auto", sources: { code: "none", openapi: false, description: false }, maxTokens: 1000 })
      .returning();
    await expectLocalError(claimLocalAnalysis(cloud!.id, "terzo", T0), "analisi non trovata o non tua");
  });

  it("etichetta oltre 100 caratteri o vuota rifiutata", async () => {
    await expectLocalError(claimLocalAnalysis(analysisId, "x".repeat(101), T0), /etichetta/);
    await expectLocalError(claimLocalAnalysis(analysisId, "   ", T0), /etichetta/);
    expect((await loadAnalysis()).status).toBe("queued");
  });
});

describe("listOpenLocalAnalyses", () => {
  it("elenca solo le locali in coda o in corso, con le fasi consegnate", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    await submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, undefined, at(1000));
    const list = await listOpenLocalAnalyses();
    expect(list).toEqual([
      {
        analysisId,
        appId,
        appName: "Fanta",
        status: "running",
        phase: "capabilities",
        deliveredPhases: ["map"],
        leaseLabel: "Mac",
        leaseUntil: at(1000 + LOCAL_LEASE_MS),
      },
    ]);
    await cancelLocalAnalysis(analysisId);
    expect(await listOpenLocalAnalyses()).toEqual([]);
  });
});

describe("submitLocalPhase", () => {
  it("le sei fasi valide completano l'analisi con il riepilogo per capitolo", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    let now = T0.getTime();
    for (const [i, phase] of PHASES.entries()) {
      now += 60_000;
      const res = await submitLocalPhase(analysisId, leaseToken, phase, PHASE_EXAMPLES[phase], "abc1234", new Date(now));
      expect(res.ok, phase).toBe(true);
      if (!res.ok) return;
      expect(res.nextPhase).toBe(PHASES[i + 1] ?? null);
      if (phase !== "evolution") {
        expect(res.summary).toBeUndefined();
        expect((await loadAnalysis()).leaseUntil!.getTime()).toBe(now + LOCAL_LEASE_MS);
      } else {
        const items = await loadItems();
        const count = (c: string) => items.filter((it) => it.chapter === c).length;
        expect(res.summary).toEqual({
          tool: count("tool"),
          endpoint: count("endpoint"),
          agent: count("agent"),
          skill: count("skill"),
          completion: count("completion"),
          evolution: count("evolution"),
        });
        expect(items.length).toBeGreaterThan(0);
      }
    }
    const row = await loadAnalysis();
    expect(row.status).toBe("completed");
    expect(row.finishedAt).not.toBeNull();
    expect(row.leaseTokenHash).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(row.sourceCommit).toBe("abc1234");
    expect(row.tokensUsed).toBe(0);
    expect(row.costUsd).toBeNull();
    expect(row.architectureMap).toMatchObject({ stack: (PHASE_EXAMPLES.map as { stack: string[] }).stack });
    const results = await db.select().from(analysisPhaseResultsTable).where(eq(analysisPhaseResultsTable.analysisId, analysisId));
    expect(results.map((r) => r.phase).sort()).toEqual([...PHASES].sort());
    expect(row.log.some((e) => e.phase === "catalog" && /consegnata/.test(e.message))).toBe(true);
  });

  it("un esito non valido torna con le issues e la fase non avanza", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    const res = await submitLocalPhase(analysisId, leaseToken, "map", { stack: "non un elenco" }, undefined, at(1000));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.length).toBeGreaterThan(0);
    expect(res.issues[0]).toMatch(/: /);
    const row = await loadAnalysis();
    expect(row.phase).toBe("map");
    expect(await db.select().from(analysisPhaseResultsTable)).toHaveLength(0);
  });

  it("la stessa fase consegnata due volte: la seconda chiede la fase attesa, nessun duplicato", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    for (const phase of ["map", "capabilities", "catalog"] as const) {
      expect((await submitLocalPhase(analysisId, leaseToken, phase, PHASE_EXAMPLES[phase], undefined, at(1000))).ok).toBe(true);
    }
    const before = (await loadItems()).length;
    await expectLocalError(
      submitLocalPhase(analysisId, leaseToken, "catalog", PHASE_EXAMPLES.catalog, undefined, at(2000)),
      "fase attesa: agents",
    );
    expect((await loadItems()).length).toBe(before);
  });

  it("dopo map, una seconda consegna di map chiede capabilities", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    await submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, undefined, at(1000));
    await expectLocalError(
      submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, undefined, at(2000)),
      "fase attesa: capabilities",
    );
  });

  it("con la lease scaduta o un token diverso: lease scaduta, gli esiti precedenti restano", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    await submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, undefined, at(1000));
    await expectLocalError(
      submitLocalPhase(analysisId, leaseToken, "capabilities", PHASE_EXAMPLES.capabilities, undefined, at(1000 + LOCAL_LEASE_MS + 1)),
      "lease scaduta: chiedi di nuovo il compito",
    );
    await expectLocalError(
      submitLocalPhase(analysisId, "token-sbagliato", "capabilities", PHASE_EXAMPLES.capabilities, undefined, at(2000)),
      "lease scaduta: chiedi di nuovo il compito",
    );
    const results = await db.select().from(analysisPhaseResultsTable);
    expect(results.map((r) => r.phase)).toEqual(["map"]);
  });

  it("commit non valido ignorato; commit diverso da quello atteso registrato nel log", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    await submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, "non-un-commit", at(1000));
    let row = await loadAnalysis();
    expect(row.sourceCommit).toBeNull();
    expect(row.log.some((e) => /atteso/.test(e.message))).toBe(false);

    setExpectedCommit(analysisId, "fedcba9");
    await submitLocalPhase(analysisId, leaseToken, "capabilities", PHASE_EXAMPLES.capabilities, "ABC1234", at(2000));
    row = await loadAnalysis();
    expect(row.sourceCommit).toBe("ABC1234");
    expect(row.log.some((e) => e.message === "analizzato il commit ABC1234, atteso fedcba9")).toBe(true);
    setExpectedCommit(analysisId, null);
  });
});

describe("localPhaseInstructions", () => {
  it("prompt della fase corrente con la premessa locale e gli esiti precedenti", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    let ins = await localPhaseInstructions(analysisId, leaseToken, at(1000));
    expect(ins.phase).toBe("map");
    expect(ins.system.endsWith(`\n\n${SYSTEM_BASE}`)).toBe(true);
    expect(ins.system).toMatch(/^Esegui questa fase con i tuoi strumenti sul clone locale/);
    expect(ins.system).toContain("submit_phase");
    expect(ins.user).toContain("App: Fanta");
    expect(ins.user).not.toContain("Mappa del repository");
    expect(ins.user).not.toContain("Esiti delle fasi precedenti");

    await submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, undefined, at(1000));
    await submitLocalPhase(analysisId, leaseToken, "capabilities", PHASE_EXAMPLES.capabilities, undefined, at(2000));
    ins = await localPhaseInstructions(analysisId, leaseToken, at(3000));
    expect(ins.phase).toBe("catalog");
    expect(ins.user).toContain("Esiti delle fasi precedenti");
    expect(ins.user.indexOf("### map")).toBeLessThan(ins.user.indexOf("### capabilities"));

    await expectLocalError(localPhaseInstructions(analysisId, "altro", at(3000)), "lease scaduta: chiedi di nuovo il compito");
  });
});

describe("lease: ping, scadenza, abbandono, rilascio, annullamento", () => {
  it("ping rinnova la lease; con la lease scaduta no", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    const res = await pingLocalAnalysis(analysisId, leaseToken, at(600_000));
    expect(res.leaseUntil.getTime()).toBe(600_000 + T0.getTime() + LOCAL_LEASE_MS);
    expect((await loadAnalysis()).leaseUntil!.getTime()).toBe(res.leaseUntil.getTime());
    await expectLocalError(
      pingLocalAnalysis(analysisId, leaseToken, at(600_000 + LOCAL_LEASE_MS + 1)),
      "lease scaduta: chiedi di nuovo il compito",
    );
  });

  it("releaseExpiredLeases rimette in coda; il nuovo claim riparte dalla prima fase senza esito", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    await submitLocalPhase(analysisId, leaseToken, "map", PHASE_EXAMPLES.map, undefined, at(1000));
    expect(await releaseExpiredLeases(at(2000))).toBe(0);
    expect(await releaseExpiredLeases(at(1000 + LOCAL_LEASE_MS + 1))).toBe(1);
    const row = await loadAnalysis();
    expect(row.status).toBe("queued");
    expect(row.leaseTokenHash).toBeNull();
    expect(row.leaseUntil).toBeNull();

    const again = await claimLocalAnalysis(analysisId, "Mac 2", at(1000 + LOCAL_LEASE_MS + 2));
    expect(again.phase).toBe("capabilities");
  });

  it("abandon chiude l'analisi come fallita con il motivo", async () => {
    const { leaseToken } = await claimLocalAnalysis(analysisId, "Mac", T0);
    await expectLocalError(abandonLocalAnalysis(analysisId, leaseToken, "x".repeat(301), at(1000)), /motivo/);
    await abandonLocalAnalysis(analysisId, leaseToken, "repository non trovato", at(1000));
    const row = await loadAnalysis();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("abbandonata dall'agente locale: repository non trovato");
    expect(row.finishedAt).not.toBeNull();
    expect(row.leaseTokenHash).toBeNull();
  });

  it("rilascio e annullamento dalla console", async () => {
    await claimLocalAnalysis(analysisId, "Mac", T0);
    const released = await releaseLocalAnalysis(analysisId);
    expect(released).toMatchObject({ status: "queued", leaseTokenHash: null, leaseUntil: null, leaseLabel: null });
    const cancelled = await cancelLocalAnalysis(analysisId);
    expect(cancelled).toMatchObject({ status: "failed", error: "annullata dalla console" });
    // Già chiusa: niente da rilasciare né da annullare
    expect(await releaseLocalAnalysis(analysisId)).toBeNull();
    expect(await cancelLocalAnalysis(analysisId)).toBeNull();
  });

  it("failInterruptedAnalyses lascia aperte le analisi locali", async () => {
    await claimLocalAnalysis(analysisId, "Mac", new Date());
    expect(await failInterruptedAnalyses()).toBe(0);
    expect((await loadAnalysis()).status).toBe("running");
  });
});
