import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  analysisItemsTable,
  appArchitectureTable,
  appsTable,
  evolutionCyclesTable,
  evolutionRoundsTable,
  githubInstallationsTable,
  usersTable,
} from "@workspace/db";

// L'analisi vera non parte: la sua fine si simula scrivendo voci e stato nel DB
vi.mock("../architect/run-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../architect/run-analysis")>();
  return { ...orig, startAnalysis: vi.fn(async () => {}) };
});
vi.mock("../architecture/service", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../architecture/service")>();
  return { ...orig, requestArchitectureRefresh: vi.fn(async () => "queued") };
});

vi.mock("../github/installations", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../github/installations")>();
  return { ...orig, userHasInstallation: vi.fn(orig.userHasInstallation) };
});

import { startAnalysis } from "../architect/run-analysis";
import { userHasInstallation } from "../github/installations";
import { requestArchitectureRefresh } from "../architecture/service";
import { ensureProviderRegistry } from "../catalog/provider-registry";
import { encryptSecret } from "../secrets";
import { CONSENT_VERSION, consentHash } from "./consent";
import { EVOLUTION_MESSAGES, roundOutcome } from "./messages";
import {
  advanceRound,
  deleteCycle,
  EvolutionError,
  failInterruptedRounds,
  getCycle,
  handleAnalysisFinished,
  listRounds,
  resumeCycle,
  saveCycle,
  startRound,
  stopCycle,
  type CycleInput,
} from "./service";
import { runEvolutionTick } from "./scheduler";

const DAY_MS = 86_400_000;
const savedKey = process.env["CASELLO_SECRET_KEY"];

let userId: number;
let modelId: number;
let appId: number;

function input(over: Partial<CycleInput> = {}): CycleInput {
  return {
    mergeMode: "direct",
    stagingBranch: null,
    teamTemplateId: null,
    analysisAiModelId: modelId,
    itemsPerRound: 2,
    monthlyBudgetUsd: 10,
    frequency: "weekly",
    stagingUrl: null,
    consent: { accepted: true, appSlug: "botcave", version: CONSENT_VERSION },
    ...over,
  };
}

async function rejection(p: Promise<unknown>): Promise<EvolutionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EvolutionError) return err;
    throw err;
  }
  throw new Error("nessun errore");
}

async function cycleRow() {
  const [row] = await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.appId, appId));
  return row!;
}

async function roundRows() {
  return db.select().from(evolutionRoundsTable);
}

/** Voci in attesa dell'analisi: due di completamento e due di evoluzione. */
async function addItems(analysisId: number) {
  const values = [
    { chapter: "completion" as const, ref: "completion:1", position: 0, payload: { key: "c1", title: "C1", phase: 1, dependsOn: [] } },
    { chapter: "completion" as const, ref: "completion:2", position: 1, payload: { key: "c2", title: "C2", phase: 2, dependsOn: [] } },
    { chapter: "evolution" as const, ref: "evolution:1", position: 2, payload: { title: "E1", priority: 1 } },
    { chapter: "evolution" as const, ref: "evolution:2", position: 3, payload: { title: "E2", priority: 2 } },
  ];
  return db
    .insert(analysisItemsTable)
    .values(values.map((v) => ({ ...v, analysisId, diff: "new" as const })))
    .returning();
}

beforeAll(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await ensureProviderRegistry();
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  vi.mocked(startAnalysis).mockClear();
  vi.mocked(requestArchitectureRefresh).mockClear();
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, users RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = u!.id;
  await db.insert(githubInstallationsTable).values({ userId, installationId: 11, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: "https://api.example.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Botcave", slug: "botcave", baseUrl: "http://localhost:1", sourceType: "github", sourceRepo: "ivan/botcave", sourceBranch: "main", sourceInstallationId: 11 })
    .returning();
  appId = app!.id;
  await db.insert(appArchitectureTable).values({ appId, summary: "## Sintesi\nTesto.", repoMap: "src/" });
});

describe("saveCycle e consenso", () => {
  it("senza consenso, con lo slug sbagliato o in modalità staging rifiuta", async () => {
    const noConsent = await rejection(saveCycle(appId, userId, input({ consent: undefined })));
    expect([noConsent.status, noConsent.message]).toEqual([400, EVOLUTION_MESSAGES.consentInvalid]);
    const wrongSlug = await rejection(saveCycle(appId, userId, input({ consent: { accepted: true, appSlug: "altra", version: CONSENT_VERSION } })));
    expect([wrongSlug.status, wrongSlug.message]).toEqual([400, EVOLUTION_MESSAGES.consentInvalid]);
    const wrongVersion = await rejection(saveCycle(appId, userId, input({ consent: { accepted: true, appSlug: "botcave", version: "2020-01-01" } })));
    expect(wrongVersion.message).toBe(EVOLUTION_MESSAGES.consentInvalid);
    const staging = await rejection(saveCycle(appId, userId, input({ mergeMode: "staging", stagingBranch: "prova" })));
    expect([staging.status, staging.message]).toEqual([400, EVOLUTION_MESSAGES.modeUnavailable]);
    expect(await getCycle(appId)).toBeNull();
  });

  it("un ciclo nuovo nasce attivo, dovuto subito, con il consenso di chi lo salva", async () => {
    const before = Date.now();
    const cycle = await saveCycle(appId, userId, input());
    expect(cycle.status).toBe("active");
    expect(cycle.activatedBy).toBe(userId);
    expect(cycle.consentVersion).toBe(CONSENT_VERSION);
    expect(cycle.consentAt).not.toBeNull();
    expect(cycle.nextRoundAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(cycle.nextRoundAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("alzare il tetto chiede un consenso nuovo, abbassarlo no e ricalcola l'impronta", async () => {
    await saveCycle(appId, userId, input());
    const up = await rejection(saveCycle(appId, userId, input({ monthlyBudgetUsd: 20, consent: undefined })));
    expect([up.status, up.message]).toEqual([400, EVOLUTION_MESSAGES.consentRenew]);
    const down = await saveCycle(appId, userId, input({ monthlyBudgetUsd: 5, consent: undefined }));
    expect(Number(down.monthlyBudgetUsd)).toBe(5);
    expect(down.consentHash).toBe(
      consentHash({ mergeMode: "direct", stagingBranch: null, teamTemplateId: null, analysisAiModelId: modelId, itemsPerRound: 2, monthlyBudgetUsd: 5 }),
    );
    // La frequenza non è nell'impronta
    const freq = await saveCycle(appId, userId, input({ monthlyBudgetUsd: 5, frequency: "daily", consent: undefined }));
    expect(freq.frequency).toBe("daily");
    const items = await rejection(saveCycle(appId, userId, input({ monthlyBudgetUsd: 5, itemsPerRound: 3, consent: undefined })));
    expect(items.message).toBe(EVOLUTION_MESSAGES.consentRenew);
  });

  it("un modello non dei propri account o un'App senza installazione sono rifiutati", async () => {
    const model = await rejection(saveCycle(appId, userId, input({ analysisAiModelId: 9999 })));
    expect(model.status).toBe(400);
    await db.delete(githubInstallationsTable);
    const access = await rejection(saveCycle(appId, userId, input()));
    expect([access.status, access.message]).toEqual([400, EVOLUTION_MESSAGES.noAccess]);
  });
});

describe("avvio del giro", () => {
  it("il tick con il ciclo dovuto crea il giro e l'analisi evolution", async () => {
    await saveCycle(appId, userId, input());
    const started = await runEvolutionTick();
    expect(started).toBe(1);
    const [round] = await roundRows();
    expect(round).toMatchObject({ number: 1, status: "analyzing" });
    const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.id, round!.analysisId!));
    expect(analysis).toMatchObject({ mode: "evolution", evolutionRoundId: round!.id, maxTokens: 150_000, status: "queued", aiModelId: modelId });
    expect(vi.mocked(startAnalysis)).toHaveBeenCalledWith(analysis!.id);
    const cycle = await cycleRow();
    expect(Math.abs(cycle.nextRoundAt!.getTime() - (round!.startedAt.getTime() + 7 * DAY_MS))).toBeLessThan(5_000);
    // Non più dovuto: il tick dopo non crea nulla
    expect(await runEvolutionTick()).toBe(0);
    expect(await roundRows()).toHaveLength(1);
  });

  it("due avvii insieme: uno riesce, l'altro risponde 409", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const results = await Promise.allSettled([startRound(cycle.id), startRound(cycle.id, { manual: true })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(EvolutionError);
    expect([failed.reason.status, failed.reason.message]).toEqual([409, EVOLUTION_MESSAGES.roundRunning]);
    expect(await roundRows()).toHaveLength(1);
  });

  it("tick e avvio manuale insieme: un solo giro", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const [, manual] = await Promise.all([runEvolutionTick(), startRound(cycle.id, { manual: true }).catch((e: unknown) => e)]);
    if (manual instanceof Error) expect((manual as EvolutionError).status).toBe(409);
    expect(await roundRows()).toHaveLength(1);
  });

  it("tetto del ciclo raggiunto: pausa senza analisi", async () => {
    const cycle = await saveCycle(appId, userId, input({ monthlyBudgetUsd: 1 }));
    const [prev] = await db.insert(evolutionRoundsTable).values({ cycleId: cycle.id, number: 1, status: "done" }).returning();
    await db.insert(analysesTable).values({
      appId,
      model: "fake-model",
      aiModelId: modelId,
      status: "completed",
      mode: "evolution",
      evolutionRoundId: prev!.id,
      costUsd: "5",
      tokensUsed: 1000,
      maxTokens: 150_000,
      sources: { code: "github", openapi: false, description: false },
    });
    await runEvolutionTick();
    const row = await cycleRow();
    expect(row).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.budgetReached });
    expect(await roundRows()).toHaveLength(1);
    expect(vi.mocked(startAnalysis)).not.toHaveBeenCalled();
  });

  it("installazione persa: pausa «accesso al repository non disponibile»", async () => {
    await saveCycle(appId, userId, input());
    await db.delete(githubInstallationsTable);
    await runEvolutionTick();
    expect(await cycleRow()).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.noAccess });
    expect(await roundRows()).toHaveLength(0);
  });

  it("consenso non più valido: pausa «consenso da rinnovare»", async () => {
    await saveCycle(appId, userId, input());
    await db.update(evolutionCyclesTable).set({ consentHash: "vecchia" }).where(eq(evolutionCyclesTable.appId, appId));
    await runEvolutionTick();
    expect(await cycleRow()).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.consentRenew });
  });

  it("senza sintesi chiede l'architettura e aspetta, senza pausa", async () => {
    const cycle = await saveCycle(appId, userId, input());
    await db.delete(appArchitectureTable);
    const err = await rejection(startRound(cycle.id, { manual: true }));
    expect([err.status, err.message]).toEqual([409, EVOLUTION_MESSAGES.waitingArchitecture]);
    expect(vi.mocked(requestArchitectureRefresh)).toHaveBeenCalledWith(appId, { bypassOff: true, clearBackoff: false });
    expect(await cycleRow()).toMatchObject({ status: "active", pausedReason: null });
    expect(await db.select().from(analysesTable)).toHaveLength(0);
  });

  it("un ciclo in pausa non parte", async () => {
    const cycle = await saveCycle(appId, userId, input());
    await stopCycle(appId);
    const err = await rejection(startRound(cycle.id, { manual: true }));
    expect([err.status, err.message]).toEqual([409, EVOLUTION_MESSAGES.paused]);
  });
});

describe("avanzamento del giro", () => {
  it("analisi completata: approva le prime N voci, chiude il giro e azzera gli errori", async () => {
    const cycle = await saveCycle(appId, userId, input());
    await db.update(evolutionCyclesTable).set({ consecutiveErrors: 2, lastError: "x" }).where(eq(evolutionCyclesTable.id, cycle.id));
    const round = await startRound(cycle.id, { manual: true });
    const items = await addItems(round.analysisId!);
    await db.update(analysesTable).set({ status: "completed" }).where(eq(analysesTable.id, round.analysisId!));

    await handleAnalysisFinished(round.analysisId!);
    const [done] = await roundRows();
    expect(done).toMatchObject({ status: "done", outcome: roundOutcome(2) });
    expect(done!.finishedAt).not.toBeNull();
    const approved = await db
      .select()
      .from(analysisItemsTable)
      .where(and(eq(analysisItemsTable.analysisId, round.analysisId!), eq(analysisItemsTable.status, "approved")));
    expect(approved.map((i) => i.id).sort()).toEqual([items[0]!.id, items[1]!.id].sort());
    expect(approved.every((i) => i.approvedByCycle && i.appliedAt !== null)).toBe(true);
    expect([...done!.itemIds].sort()).toEqual([items[0]!.id, items[1]!.id].sort());
    const row = await cycleRow();
    expect(row).toMatchObject({ consecutiveErrors: 0, lastError: null, status: "active" });
    expect(Math.abs(row.nextRoundAt!.getTime() - (round.startedAt.getTime() + 7 * DAY_MS))).toBeLessThan(5_000);

    // Idempotente
    await advanceRound(round.id);
    expect((await roundRows())[0]!.status).toBe("done");
    expect(await listRounds(appId)).toHaveLength(1);
  });

  it("il tick fa avanzare un giro con l'analisi finita (avviso di fine perso)", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const round = await startRound(cycle.id, { manual: true });
    await addItems(round.analysisId!);
    await db.update(analysesTable).set({ status: "completed" }).where(eq(analysesTable.id, round.analysisId!));
    expect(await runEvolutionTick()).toBe(0);
    expect((await roundRows())[0]).toMatchObject({ status: "done", outcome: roundOutcome(2) });
  });

  it("nessuna voce candidata: «nessuna voce nuova»", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const round = await startRound(cycle.id, { manual: true });
    await db.update(analysesTable).set({ status: "completed" }).where(eq(analysesTable.id, round.analysisId!));
    await advanceRound(round.id);
    expect((await roundRows())[0]).toMatchObject({ status: "done", outcome: EVOLUTION_MESSAGES.noNewItems, itemIds: [] });
  });

  it("analisi fallita: giro fallito con l'errore e backoff", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const round = await startRound(cycle.id, { manual: true });
    await db.update(analysesTable).set({ status: "failed", error: "fase completion: limite di token" }).where(eq(analysesTable.id, round.analysisId!));
    const before = Date.now();
    await advanceRound(round.id);
    expect((await roundRows())[0]).toMatchObject({ status: "failed", outcome: "fase completion: limite di token" });
    const row = await cycleRow();
    expect(row).toMatchObject({ consecutiveErrors: 1, status: "active" });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 1_800_000 - 1000);
  });

  it("stopCycle durante l'analisi: giro fermato, analisi fallita, nessuna voce approvata", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const round = await startRound(cycle.id, { manual: true });
    const stopped = await stopCycle(appId);
    expect(stopped).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.stoppedByUser });
    expect((await roundRows())[0]!.status).toBe("stopped");
    const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.id, round.analysisId!));
    expect(analysis).toMatchObject({ status: "failed", error: EVOLUTION_MESSAGES.analysisStopped });

    // Anche se l'analisi risultasse completata, il giro fermato non approva nulla
    await addItems(round.analysisId!);
    await db.update(analysesTable).set({ status: "completed" }).where(eq(analysesTable.id, round.analysisId!));
    await advanceRound(round.id);
    const approved = await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.status, "approved"));
    expect(approved).toHaveLength(0);
    expect((await roundRows())[0]!.status).toBe("stopped");
  });

  it("giro con l'analisi interrotta: failInterruptedRounds lo chiude e conta l'errore", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const round = await startRound(cycle.id, { manual: true });
    await db.update(analysesTable).set({ status: "interrupted" }).where(eq(analysesTable.id, round.analysisId!));
    expect(await failInterruptedRounds()).toBe(1);
    expect((await roundRows())[0]).toMatchObject({ status: "failed", outcome: EVOLUTION_MESSAGES.restartInterrupted });
    expect((await cycleRow()).consecutiveErrors).toBe(1);
  });

  it("cinque fallimenti di fila mettono il ciclo in pausa", async () => {
    const cycle = await saveCycle(appId, userId, input());
    for (let i = 0; i < 5; i++) {
      const round = await startRound(cycle.id, { manual: true });
      await db.update(analysesTable).set({ status: "failed", error: "errore" }).where(eq(analysesTable.id, round.analysisId!));
      await advanceRound(round.id);
    }
    expect(await cycleRow()).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.tooManyErrors, consecutiveErrors: 5 });
  });
});

describe("correzioni: nuovo tentativo, giro senza analisi, pausa condizionata", () => {
  /** Il tick fa partire il giro dovuto e lo fa fallire con l'analisi `failed`. */
  async function tickAndFail(): Promise<void> {
    expect(await runEvolutionTick()).toBe(1);
    const rounds = await roundRows();
    const open = rounds.find((r) => r.status === "analyzing")!;
    await db.update(analysesTable).set({ status: "failed", error: "errore" }).where(eq(analysesTable.id, open.analysisId!));
    // Il tick dopo chiude il giro; il ciclo non riparte finché l'attesa non è passata
    expect(await runEvolutionTick()).toBe(0);
  }

  it("un giro fallito si riprova dal tick dopo l'attesa (30, 60 min…), non dopo la frequenza; al quinto pausa", async () => {
    await saveCycle(appId, userId, input({ frequency: "weekly" }));
    const waits = [30, 60, 120, 240];
    for (let i = 0; i < 4; i++) {
      const before = Date.now();
      await tickAndFail();
      const row = await cycleRow();
      expect(row).toMatchObject({ status: "active", consecutiveErrors: i + 1 });
      expect(row.nextRoundAt!.getTime()).toBeLessThanOrEqual(Date.now());
      const wait = row.nextAttemptAt!.getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(waits[i]! * 60_000 - 1000);
      expect(wait).toBeLessThan(waits[i]! * 60_000 + 5_000);
      // Passata l'attesa (non sette giorni) il tick riparte
      await db.update(evolutionCyclesTable).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(evolutionCyclesTable.id, row.id));
    }
    await tickAndFail();
    expect(await cycleRow()).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.tooManyErrors, consecutiveErrors: 5 });
    expect(await roundRows()).toHaveLength(5);
  });

  it("il tick chiude un giro rimasto senza analisi", async () => {
    const cycle = await saveCycle(appId, userId, input());
    const round = await startRound(cycle.id, { manual: true });
    await db.update(evolutionRoundsTable).set({ analysisId: null }).where(eq(evolutionRoundsTable.id, round.id));
    await runEvolutionTick();
    expect((await roundRows()).find((r) => r.id === round.id)).toMatchObject({ status: "failed", outcome: EVOLUTION_MESSAGES.restartInterrupted });
    expect((await cycleRow()).consecutiveErrors).toBe(1);
  });

  it("una pausa da una lettura vecchia non sovrascrive «fermato dall'utente»", async () => {
    const cycle = await saveCycle(appId, userId, input());
    // startRound ha già letto il ciclo attivo; l'utente lo ferma prima del controllo dell'installazione, che fallisce
    vi.mocked(userHasInstallation).mockImplementationOnce(async () => {
      await stopCycle(appId);
      return false;
    });
    const err = await rejection(startRound(cycle.id, { manual: true }));
    expect(err.message).toBe(EVOLUTION_MESSAGES.noAccess);
    expect(await cycleRow()).toMatchObject({ status: "paused", pausedReason: EVOLUTION_MESSAGES.stoppedByUser });
  });
});

describe("Riprendi ed elimina", () => {
  it("riprende con un consenso valido e azzera gli errori", async () => {
    await saveCycle(appId, userId, input());
    await stopCycle(appId);
    await db.update(evolutionCyclesTable).set({ consecutiveErrors: 3 }).where(eq(evolutionCyclesTable.appId, appId));
    const resumed = await resumeCycle(appId, userId);
    expect(resumed).toMatchObject({ status: "active", pausedReason: null, consecutiveErrors: 0, nextAttemptAt: null });

    await stopCycle(appId);
    await db.update(evolutionCyclesTable).set({ consentHash: "vecchia" }).where(eq(evolutionCyclesTable.appId, appId));
    const err = await rejection(resumeCycle(appId, userId));
    expect([err.status, err.message]).toEqual([400, EVOLUTION_MESSAGES.consentRenew]);
  });

  it("non si elimina un ciclo attivo; fermato sì", async () => {
    await saveCycle(appId, userId, input());
    const err = await rejection(deleteCycle(appId));
    expect([err.status, err.message]).toEqual([409, EVOLUTION_MESSAGES.stopBeforeDelete]);
    await stopCycle(appId);
    await deleteCycle(appId);
    expect(await getCycle(appId)).toBeNull();
    const missing = await rejection(deleteCycle(appId));
    expect(missing.status).toBe(404);
  });
});
