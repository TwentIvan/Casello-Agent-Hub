import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  nodesTable,
  nodeTurnsTable,
  pendingActionsTable,
  teamInstancesTable,
  teamTurnStepsTable,
  teamTurnsTable,
  type InstanceRoleData,
} from "@workspace/db";
import { seedNodeTurnSetup, type NodeTurnSetup } from "../../../test/node-turn-fixture";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "../../../test/fake-provider";
import { encryptSecret } from "../secrets";
import { approveAction } from "../actions/decide";
import { NODE_TURN_MESSAGES } from "../node-turns/messages";
import { claimTurn, reportTurn, type TurnPackage } from "../node-turns/protocol";
import { turnEntry } from "../node-turns/registry";
import { listEvents } from "./events";
import { getPlan } from "./plan";
import { TASK_MESSAGES, settleTaskExecutions } from "./task-runner";
import { setOnTurnQueued } from "./turn-queue";
import { LEAD_NODE_TIMEOUT_MS, activateInstance, pumpTurnInBackground, settleTurnExecutions } from "./turn-runner";

// Capo con un modello Claude Code (nodo): il turno si delega al nodo dell'account. Il test fa da nodo finto (claimTurn,
// chiamate agli strumenti dalla voce del registro come /mcp/turn, reportTurn); il ripiego usa un provider finto.

const SEC = 1000;
let setup: NodeTurnSetup;
let fake: FakeProvider;
let fallbackScript: FakeChatReply[];
let restoreLoopback: () => void;
let appId: number;
const savedKey = process.env["CASELLO_SECRET_KEY"];

const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (name: string, args: Record<string, unknown>): FakeChatReply => ({
  content: null,
  toolCalls: [{ id: `c_${name}`, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const PROPOSAL = {
  objective: "Chiudere il WI 1174",
  constraints: [],
  openPoints: [],
  tasks: [{ title: "Analisi del WI", roleKey: "capo", instructions: "Analizza il WI 1174" }],
};

const lead = (aiModelId: number): InstanceRoleData => ({
  key: "capo",
  name: "Capo",
  task: "Coordina il lavoro.",
  isLead: true,
  runsOn: "cloud",
  aiModelId,
  tools: [],
  skills: [],
  localSkills: [],
});

async function seedTeam(): Promise<number> {
  const [row] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra WI", refAppId: appId, refType: "wi", refId: "1174", refTitle: "WI 1174", status: "draft", roles: [lead(setup.aiModelId)], createdBy: setup.userId })
    .returning();
  return row!.id;
}

async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await settleTurnExecutions();
    await settleTaskExecutions();
  }
}

const markNodeReady = () => db.update(nodesTable).set({ lastTurnPollAt: new Date() }).where(eq(nodesTable.id, setup.nodeId));
const turns = (id: number) => db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, id)).orderBy(asc(teamTurnsTable.id));
const steps = (turnId: number) => db.select().from(teamTurnStepsTable).where(eq(teamTurnStepsTable.turnId, turnId)).orderBy(asc(teamTurnStepsTable.position));

/** Prende il turno appena accodato (attende che l'attivazione lo accodi). */
async function claim(): Promise<TurnPackage> {
  for (let i = 0; i < 50; i++) {
    const pkg = await claimTurn(setup.nodeId, 100);
    if (pkg) return pkg;
  }
  throw new Error("nessun turno preso");
}

async function seedFallback(): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: setup.userId, name: "Cloud", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Cloud base" }).returning();
  await db.update(aiAccountsTable).set({ fallbackAiModelId: model!.id }).where(eq(aiAccountsTable.nodeId, setup.nodeId));
  return model!.id;
}

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
  setOnTurnQueued(pumpTurnInBackground);
});
afterAll(async () => {
  setOnTurnQueued(() => {});
  restoreLoopback();
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  fallbackScript = [];
  fake = await startFakeProvider({ chatReply: () => fallbackScript.shift() ?? text("fine turno") });
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
  setup = await seedNodeTurnSetup("capo-nodo@example.com", "Mac di Ivan");
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://hub.example" }).returning();
  appId = app!.id;
});

afterEach(async () => {
  await settleAll();
  vi.restoreAllMocks();
  await fake.close();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

describe("capo con Claude Code (nodo)", () => {
  it("il turno va al nodo: strumenti del capo su /mcp/turn, voce plan in coda, passo model con la nota, costo riferito", async () => {
    await markNodeReady();
    const id = await seedTeam();
    await activateInstance(setup.userId, id);
    const pkg = await claim();
    expect(pkg).toMatchObject({ model: "sonnet", maxTurns: 11, timeoutMs: LEAD_NODE_TIMEOUT_MS });
    expect(pkg.systemPrompt).toContain("Sei il capo");
    const entry = turnEntry(pkg.id)!;
    expect(entry.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(["leggi_piano", "proponi_piano", "assegna_compito", "segnala"]));
    const result = await entry.dispatch({ id: "c1", name: "proponi_piano", arguments: JSON.stringify(PROPOSAL) });
    expect(result).not.toMatch(/"ok":\s*false|^Errore/);
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "done", content: "Piano proposto.", promptTokens: 100, completionTokens: 20, costUsd: 0.05 });
    await settleAll();

    const [turn] = await turns(id);
    expect(turn).toMatchObject({ status: "done", aiModelId: setup.aiModelId, promptTokens: 100, completionTokens: 20, costUsd: "0.050000" });
    expect((await steps(turn!.id)).map((s) => [s.type, s.toolName, s.ok, s.note])).toEqual([
      ["tool", "proponi_piano", true, null],
      ["model", null, true, "Claude Code sul nodo «Mac di Ivan»"],
    ]);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.teamInstanceId, id));
    expect(item).toMatchObject({ kind: "plan", status: "pending", userId: setup.userId });
    expect((await getPlan(id)).status).toBe("proposed");
    const [nodeTurn] = await db.select().from(nodeTurnsTable);
    expect(nodeTurn).toMatchObject({ consumer: "team_turn", refId: turn!.id, status: "done" });
    expect(fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);
  });

  it("report failed: turno failed col messaggio fisso del nodo ed evento bloccato", async () => {
    await markNodeReady();
    const id = await seedTeam();
    await activateInstance(setup.userId, id);
    const pkg = await claim();
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "failed", errorCode: "timeout" });
    await settleAll();
    const [turn] = await turns(id);
    expect(turn).toMatchObject({ status: "failed", error: NODE_TURN_MESSAGES.timeout });
    expect((await listEvents(id)).some((e) => e.type === "bloccato" && e.bulletin.includes(NODE_TURN_MESSAGES.timeout))).toBe(true);
  });

  it("nodo non pronto con un ripiego: il turno gira sul modello cloud, che ne prende la spesa", async () => {
    const fallbackId = await seedFallback();
    fallbackScript.push(call("proponi_piano", PROPOSAL), text("Piano proposto col ripiego."));
    const id = await seedTeam();
    await activateInstance(setup.userId, id);
    await settleAll();
    const [turn] = await turns(id);
    expect(turn).toMatchObject({ status: "done", aiModelId: fallbackId });
    const s = await steps(turn!.id);
    expect(s[0]).toMatchObject({ type: "model", ok: true, note: "Claude Code non disponibile: turno eseguito con Cloud base" });
    expect(await db.select().from(nodeTurnsTable)).toHaveLength(0);
    expect((await getPlan(id)).status).toBe("proposed");
  });

  it("nodo non pronto senza ripiego: turno failed con il messaggio del nodo offline", async () => {
    const id = await seedTeam();
    await activateInstance(setup.userId, id);
    await settleAll();
    const [turn] = await turns(id);
    expect(turn).toMatchObject({ status: "failed", error: NODE_TURN_MESSAGES.offline("Mac di Ivan") });
  });

  it("un compito assegnato al capo con il modello nodo fallisce col messaggio fisso", async () => {
    await markNodeReady();
    const id = await seedTeam();
    await activateInstance(setup.userId, id);
    const pkg = await claim();
    const entry = turnEntry(pkg.id)!;
    await entry.dispatch({ id: "c1", name: "proponi_piano", arguments: JSON.stringify(PROPOSAL) });
    await reportTurn(setup.nodeId, pkg.id, { leaseToken: pkg.leaseToken, status: "done", content: "ok" });
    await settleAll();
    // Approvazione diretta del PLAN e assegnazione al capo da un secondo turno
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.teamInstanceId, id));
    await markNodeReady();
    await approveAction(setup.userId, item!.number);
    const pkg2 = await claim();
    const plan = await getPlan(id);
    const assigned = await turnEntry(pkg2.id)!.dispatch({ id: "c2", name: "assegna_compito", arguments: JSON.stringify({ taskId: plan.tasks[0]!.id }) });
    expect(assigned).toContain(`compito ${plan.tasks[0]!.id} assegnato`);
    await reportTurn(setup.nodeId, pkg2.id, { leaseToken: pkg2.leaseToken, status: "done", content: "assegnato" });
    // Il compito fallito sveglia di nuovo il capo (task_finished): il nodo finto prende anche quel turno
    const pkg3 = await claim();
    expect((await getPlan(id)).tasks[0]).toMatchObject({ status: "failed", outcome: TASK_MESSAGES.nodeModelTask });
    await reportTurn(setup.nodeId, pkg3.id, { leaseToken: pkg3.leaseToken, status: "done", content: "visto" });
    await settleAll();
  }, 20_000);
});
