import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
  pendingActionsTable,
  teamEventsTable,
  teamInstancesTable,
  teamTasksTable,
  teamTurnsTable,
  teamWorksTable,
  usersTable,
} from "@workspace/db";

// L'analisi vera non parte: le voci del giro si scrivono nel DB
vi.mock("../architect/run-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../architect/run-analysis")>();
  return { ...orig, startAnalysis: vi.fn(async () => {}) };
});

import { ensureProviderRegistry } from "../catalog/provider-registry";
import { encryptSecret } from "../secrets";
import { enqueuePlanItem } from "../actions/queue";
import { setInstanceBudget } from "../teams/instances";
import { writePlanVersion } from "../teams/plan";
import { teamCapBlock } from "../teams/team-budget";
import { pumpTurn } from "../teams/turn-runner";
import { setOnTurnQueued } from "../teams/turn-queue";
import { createTemplate } from "../teams/templates";
import type { TemplateRole } from "../teams/manifest";
import { CONSENT_VERSION } from "./consent";
import { autoApprovePlanItem, cyclePausedForTeam } from "./cycle-team";
import { EVOLUTION_MESSAGES } from "./messages";
import { cycleSpend } from "./spend";
import {
  EvolutionError,
  advanceRound,
  resumeCycle,
  saveCycle,
  startRound,
  stopCycle,
  syncOpenTeamRounds,
  syncTeamRounds,
  type CycleInput,
} from "./service";

// Squadra del ciclo (3c, spec §15.8), PGlite senza rete: creazione della squadra al primo giro con voci, messaggio «Implementa»,
// PLAN approvato dal ciclo, giro che segue il lavoro (prova, rifiuto con nota, produzione, abbandono, scadenza), tetto del ciclo,
// «Ferma» e «Riprendi». I turni del capo non partono (aggancio della coda dei turni spento).

const savedKey = process.env["CASELLO_SECRET_KEY"];
let userId: number;
let modelId: number;
let appId: number;
let templateId: number;

const role = (over: Partial<TemplateRole> = {}): TemplateRole => ({
  key: "capo",
  name: "Capo",
  task: "Coordina",
  isLead: true,
  runsOn: "cloud",
  aiModelId: modelId,
  tools: [],
  code: "none",
  skills: [],
  ...over,
});

function input(over: Partial<CycleInput> = {}): CycleInput {
  return {
    teamTemplateId: templateId,
    analysisAiModelId: modelId,
    itemsPerRound: 2,
    monthlyBudgetUsd: 10,
    frequency: "weekly",
    consent: { accepted: true, appSlug: "botcave", version: CONSENT_VERSION },
    ...over,
  };
}

async function rejection(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof EvolutionError || (err instanceof Error && "status" in err)) return err as unknown as { status: number; message: string };
    throw err;
  }
  throw new Error("nessun errore");
}

const cycleRow = async () => (await db.select().from(evolutionCyclesTable).where(eq(evolutionCyclesTable.appId, appId)))[0]!;
const roundRow = async (id: number) => (await db.select().from(evolutionRoundsTable).where(eq(evolutionRoundsTable.id, id)))[0]!;
const teamRow = async (id: number) => (await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, id)))[0]!;
const queuedTurn = async (id: number) =>
  (await db.select().from(teamTurnsTable).where(and(eq(teamTurnsTable.instanceId, id), eq(teamTurnsTable.status, "queued"))))[0];

/** Giro completo fino all'implementazione: avvio, analisi «finita» con due voci, avanzamento. */
async function roundToImplementation(): Promise<{ roundId: number; itemIds: number[] }> {
  const round = await startRound((await cycleRow()).id, { manual: true });
  const [analysis] = await db
    .update(analysesTable)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(analysesTable.id, round.analysisId!))
    .returning();
  const items = await db
    .insert(analysisItemsTable)
    .values([
      { analysisId: analysis!.id, chapter: "completion", ref: "completion:1", position: 0, diff: "new", payload: { key: "c1", title: "Classifica", phase: 1, dependsOn: [] } },
      { analysisId: analysis!.id, chapter: "evolution", ref: "evolution:1", position: 1, diff: "new", payload: { title: "Esporta CSV", priority: 1 } },
    ])
    .returning();
  await db.update(analysisItemsTable).set({ issueNumber: 41 }).where(eq(analysisItemsTable.id, items[0]!.id));
  await advanceRound(round.id);
  return { roundId: round.id, itemIds: items.map((i) => i.id) };
}

/** Lavoro della squadra creato adesso (orologio del DB, dopo il messaggio «Implementa»). */
async function addWork(instanceId: number, status: "open" | "awaiting_release" | "released" | "abandoned", number = 1) {
  const [work] = await db
    .insert(teamWorksTable)
    .values({ instanceId, number, status, repo: "ivan/botcave", branch: `botcave/lavoro-${instanceId}-${number}`, baseBranch: "main", baseSha: "a".repeat(40) })
    .returning();
  return work!;
}

async function releaseItem(instanceId: number, workId: number) {
  const [last] = await db.select({ n: sql<number>`coalesce(max(${pendingActionsTable.number}), 0)::int` }).from(pendingActionsTable).where(eq(pendingActionsTable.userId, userId));
  const [item] = await db
    .insert(pendingActionsTable)
    .values({ userId, number: (last?.n ?? 0) + 1, kind: "release", teamInstanceId: instanceId, argsEnc: encryptSecret("{}"), argsPublic: {}, recipient: "ivan/botcave", summary: "Porta in produzione il lavoro 1" })
    .returning();
  await db.update(teamWorksTable).set({ status: "awaiting_release", pendingActionId: item!.id }).where(eq(teamWorksTable.id, workId));
  return item!;
}

beforeAll(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  setOnTurnQueued(() => {});
  await ensureProviderRegistry();
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, users, team_templates RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, users, team_templates RESTART IDENTITY CASCADE");
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
  const template = await createTemplate(userId, {
    name: "Sviluppo",
    roles: [role(), role({ key: "dev", name: "Sviluppatore", isLead: false, code: "write" })],
  });
  templateId = template.id;
});

describe("impostazioni con il modello di squadra", () => {
  it("rifiuta un modello senza un ruolo che scrive codice", async () => {
    const noCode = await createTemplate(userId, { name: "Solo capo", roles: [role()] });
    const err = await rejection(saveCycle(appId, userId, input({ teamTemplateId: noCode.id })));
    expect([err.status, err.message]).toEqual([400, EVOLUTION_MESSAGES.templateNoCode]);
  });
});

describe("squadra del ciclo e giro che segue il lavoro", () => {
  it("crea la squadra al primo giro con voci, le manda «Implementa» e la attiva con chi paga", async () => {
    await saveCycle(appId, userId, input());
    const { roundId, itemIds } = await roundToImplementation();
    const round = await roundRow(roundId);
    expect(round.status).toBe("implementing");
    expect(round.finishedAt).toBeNull();
    expect(round.implementationStartedAt).not.toBeNull();
    const cycle = await cycleRow();
    expect(round.teamInstanceId).toBe(cycle.teamInstanceId);
    const team = await teamRow(cycle.teamInstanceId!);
    expect(team).toMatchObject({ status: "active", activatedBy: userId, refType: "evoluzione", refId: String(appId), name: "Evoluzione di Botcave", monthlyBudgetUsd: "10.00" });
    const turn = await queuedTurn(team.id);
    const request = turn!.reasons.find((r) => r.type === "request") as { text: string };
    expect(request.text).toContain(`#${itemIds[0]} Classifica (issue #41)`);
    expect(request.text).toContain(`#${itemIds[1]} Esporta CSV`);
    expect(request.text).toContain("giro 1 del ciclo");
    expect(turn!.reasons.some((r) => r.type === "activation")).toBe(true);
    const events = await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, team.id));
    expect(events.some((e) => e.type === "giro_evoluzione")).toBe(true);
  });

  it("approva da solo il PLAN della squadra del ciclo attivo, non con il ciclo in pausa", async () => {
    await saveCycle(appId, userId, input());
    await roundToImplementation();
    const teamId = (await cycleRow()).teamInstanceId!;
    const propose = async () => {
      const view = await writePlanVersion(teamId, { objective: "Fare", constraints: [], openPoints: [], tasks: [{ id: "t1", title: "T", roleKey: "dev", instructions: "x", status: "planned", outcome: null }], manualActions: [] }, "proposed");
      const queued = await enqueuePlanItem({ userId, instanceId: teamId, kind: "plan", planVersion: view.version, recipient: "S", summary: "PLAN", detail: {} });
      if (!queued.ok) throw new Error(queued.message);
      return queued.number;
    };
    const first = await propose();
    expect(await autoApprovePlanItem(teamId, userId, first)).toBe(true);
    const [item] = await db.select().from(pendingActionsTable).where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, first)));
    expect(item).toMatchObject({ status: "done", decidedBy: userId, decidedByCycle: true });

    await stopCycle(appId);
    const second = await propose();
    expect(await autoApprovePlanItem(teamId, userId, second)).toBe(false);
  });

  it("prova → rifiuto con nota → di nuovo in implementazione → produzione; nessun giro nuovo con il lavoro aperto", async () => {
    await saveCycle(appId, userId, input());
    const { roundId } = await roundToImplementation();
    const teamId = (await cycleRow()).teamInstanceId!;
    const work = await addWork(teamId, "open");
    await syncTeamRounds(teamId);
    expect((await roundRow(roundId)).workId).toBe(work.id);

    // Lavoro aperto: niente giro nuovo (transitorio, il ciclo resta attivo)
    await db.update(evolutionRoundsTable).set({ status: "blocked" }).where(eq(evolutionRoundsTable.id, roundId));
    const busy = await rejection(startRound((await cycleRow()).id, { manual: true }));
    expect([busy.status, busy.message]).toEqual([409, EVOLUTION_MESSAGES.workOpen]);
    expect((await cycleRow()).status).toBe("active");
    await db.update(evolutionRoundsTable).set({ status: "implementing" }).where(eq(evolutionRoundsTable.id, roundId));

    const item = await releaseItem(teamId, work.id);
    await syncTeamRounds(teamId);
    expect(await roundRow(roundId)).toMatchObject({ status: "awaiting_release", pendingActionId: item.id, outcome: "lavoro 1 in prova: Porta in produzione da decidere" });

    // L'utente rifiuta con una nota: il lavoro torna aperto
    await db.update(pendingActionsTable).set({ status: "rejected", decidedBy: userId, decisionNote: "Manca la paginazione" }).where(eq(pendingActionsTable.id, item.id));
    await db.update(teamWorksTable).set({ status: "open", pendingActionId: null }).where(eq(teamWorksTable.id, work.id));
    await syncTeamRounds(teamId);
    expect(await roundRow(roundId)).toMatchObject({ status: "implementing", pendingActionId: null, rejectionNote: "Manca la paginazione" });

    const again = await releaseItem(teamId, work.id);
    await syncTeamRounds(teamId);
    expect((await roundRow(roundId)).status).toBe("awaiting_release");
    await db.update(pendingActionsTable).set({ status: "done" }).where(eq(pendingActionsTable.id, again.id));
    await db.update(teamWorksTable).set({ status: "released" }).where(eq(teamWorksTable.id, work.id));
    await syncTeamRounds(teamId);
    const done = await roundRow(roundId);
    expect(done).toMatchObject({ status: "done", outcome: "lavoro 1 in produzione", rejectionNote: "Manca la paginazione" });
    expect(done.finishedAt).not.toBeNull();
  });

  it("un lavoro abbandonato chiude il giro bloccato; un giro senza lavoro scade dopo 72 ore", async () => {
    await saveCycle(appId, userId, input());
    const { roundId } = await roundToImplementation();
    const teamId = (await cycleRow()).teamInstanceId!;
    await addWork(teamId, "abandoned");
    await syncTeamRounds(teamId);
    expect(await roundRow(roundId)).toMatchObject({ status: "blocked", outcome: EVOLUTION_MESSAGES.nothingCompleted });

    // Giro successivo (la squadra si riusa) senza lavoro e con il messaggio di 73 ore fa
    const second = await roundToImplementation();
    expect((await roundRow(second.roundId)).teamInstanceId).toBe(teamId);
    await db.update(evolutionRoundsTable).set({ implementationStartedAt: sql`now() - interval '73 hours'` }).where(eq(evolutionRoundsTable.id, second.roundId));
    await syncOpenTeamRounds();
    expect(await roundRow(second.roundId)).toMatchObject({ status: "blocked", outcome: EVOLUTION_MESSAGES.roundExpired });
  });

  it("tetto della squadra = tetto del ciclo, che somma analisi, turni e compiti", async () => {
    await saveCycle(appId, userId, input({ monthlyBudgetUsd: 5 }));
    await roundToImplementation();
    const teamId = (await cycleRow()).teamInstanceId!;
    expect(await teamCapBlock(teamId)).toBeNull();
    await db.insert(teamTasksTable).values({ instanceId: teamId, planTaskId: "t1", roleKey: "dev", instructions: "x", status: "done", costUsd: "3" });
    await db.update(analysesTable).set({ costUsd: "2.5" }).where(eq(analysesTable.appId, appId));
    expect((await cycleSpend(appId)).spentUsd).toBeCloseTo(5.5);
    expect(await teamCapBlock(teamId)).toBe(EVOLUTION_MESSAGES.budgetReached);
    const err = await rejection(setInstanceBudget(teamId, 100));
    expect([err.status, err.message]).toEqual([409, EVOLUTION_MESSAGES.teamBudgetFromCycle]);
  });

  it("Ferma annulla i compiti in coda e tiene fermi i turni; il giro con la squadra resta aperto; Riprendi scrive al capo", async () => {
    await saveCycle(appId, userId, input());
    const { roundId } = await roundToImplementation();
    const teamId = (await cycleRow()).teamInstanceId!;
    await writePlanVersion(teamId, { objective: "Fare", constraints: [], openPoints: [], tasks: [{ id: "t1", title: "T", roleKey: "dev", instructions: "x", status: "running", outcome: null }], manualActions: [] }, "approved");
    await db.insert(teamTasksTable).values({ instanceId: teamId, planTaskId: "t1", roleKey: "dev", instructions: "x", status: "queued" });

    await stopCycle(appId);
    expect((await roundRow(roundId)).status).toBe("implementing");
    const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, teamId));
    expect(task).toMatchObject({ status: "cancelled", outcome: EVOLUTION_MESSAGES.cyclePaused });
    expect(await cyclePausedForTeam(teamId)).toBe(true);
    expect(await pumpTurn(teamId)).toBeNull();
    expect(await queuedTurn(teamId)).toBeDefined();

    await resumeCycle(appId, userId);
    expect(await cyclePausedForTeam(teamId)).toBe(false);
    const turn = await queuedTurn(teamId);
    expect(turn!.reasons.some((r) => r.type === "request" && r.text === EVOLUTION_MESSAGES.resumeRequest)).toBe(true);
  });
});
