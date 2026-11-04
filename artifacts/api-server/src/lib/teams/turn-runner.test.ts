import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  pendingActionsTable,
  teamInstancesTable,
  teamTasksTable,
  teamTurnStepsTable,
  teamTurnsTable,
  usersTable,
  type InstanceRoleData,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { approveAction, rejectAction } from "../actions/decide";
import { enqueuePlanItem } from "../actions/queue";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "../../../test/fake-provider";
import { listEvents } from "./events";
import { closeInstance } from "./instances";
import { LEAD_MESSAGES } from "./lead-tools";
import { getPlan, patchPlan, writePlanVersion } from "./plan";
import { TASK_MESSAGES, settleTaskExecutions, startTask } from "./task-runner";
import { TEAM_BUDGET_REACHED } from "./team-budget";
import { enqueueTurnReason, setOnTurnQueued } from "./turn-queue";
import { activateInstance, pumpTurnInBackground, runTurn, sendToLead, settleTurnExecutions } from "./turn-runner";

// Turni del capo con un modello finto che recita il capo (e i ruoli): attivazione, piano, coda, compiti, chiusura

let fake: FakeProvider;
let leadScript: FakeChatReply[];
let workerScript: FakeChatReply[];
let restoreLoopback: () => void;
let userId: number;
let modelId: number;
let appId: number;

const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatBody = { messages: { role: string; content: string | null; tool_call_id?: string }[]; tools: any[] };
const isLeadBody = (body: unknown) => String((body as ChatBody).messages?.[0]?.content ?? "").startsWith("Sei il capo");
const leadRequests = () => fake.requests.filter((r) => r.path === "/v1/chat/completions" && isLeadBody(r.body)).map((r) => r.body as ChatBody);
const chatCount = () => fake.requests.filter((r) => r.path === "/v1/chat/completions").length;
const userMessages = (body: ChatBody) => body.messages.filter((m) => m.role === "user").map((m) => m.content ?? "");
const toolMessages = (body: ChatBody) => body.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "");

const role = (over: Partial<InstanceRoleData> = {}): InstanceRoleData => ({
  key: "analista",
  name: "Analista",
  task: "Analizza i work item.",
  isLead: false,
  runsOn: "cloud",
  aiModelId: modelId,
  tools: [],
  skills: [],
  localSkills: [],
  ...over,
});
const lead = () => role({ key: "capo", name: "Capo", isLead: true, task: "Coordina il lavoro sul WI." });

const PROPOSAL = {
  objective: "Chiudere il WI 1174",
  constraints: ["niente rilasci il venerdì"],
  openPoints: [],
  tasks: [{ title: "Analisi del WI", roleKey: "analista", instructions: "Analizza il WI 1174" }],
};

async function seedTeam(over: { status?: "draft" | "active"; monthlyBudgetUsd?: string } = {}): Promise<number> {
  const status = over.status ?? "draft";
  const [row] = await db
    .insert(teamInstancesTable)
    .values({
      name: "Squadra WI",
      refAppId: appId,
      refType: "wi",
      refId: "1174",
      refTitle: "WI 1174",
      status,
      roles: [lead(), role()],
      createdBy: userId,
      activatedBy: status === "active" ? userId : null,
      ...(over.monthlyBudgetUsd ? { monthlyBudgetUsd: over.monthlyBudgetUsd } : {}),
    })
    .returning();
  return row!.id;
}

/** Squadra attiva con il PLAN approvato (t1 dell'analista). */
async function seedActiveApproved(over: { monthlyBudgetUsd?: string } = {}): Promise<number> {
  const id = await seedTeam({ status: "active", ...over });
  await writePlanVersion(
    id,
    {
      objective: "Chiudere il WI 1174",
      constraints: [],
      openPoints: [],
      manualActions: [],
      tasks: [{ id: "t1", title: "Analisi del WI", roleKey: "analista", instructions: "Analizza", status: "planned", outcome: null }],
    },
    "approved",
  );
  return id;
}

/** Attende turni e compiti, compresi quelli che si generano a vicenda. */
async function settleAll(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await settleTurnExecutions();
    await settleTaskExecutions();
  }
}

const turns = (instanceId: number) => db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId)).orderBy(asc(teamTurnsTable.id));
const items = (instanceId: number) => db.select().from(pendingActionsTable).where(eq(pendingActionsTable.teamInstanceId, instanceId)).orderBy(asc(pendingActionsTable.id));

/** Attiva la squadra con un capo che propone PROPOSAL; restituisce il numero della voce `plan`. */
async function activateAndPropose(instanceId: number): Promise<number> {
  leadScript.push(call("proponi_piano", PROPOSAL), text("Piano proposto."));
  await activateInstance(userId, instanceId);
  await settleAll();
  const [item] = await items(instanceId);
  return item!.number;
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

const savedKey = process.env["CASELLO_SECRET_KEY"];

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  leadScript = [];
  workerScript = [];
  fake = await startFakeProvider({
    chatReply: (body) => (isLeadBody(body) ? (leadScript.shift() ?? text("fine turno")) : (workerScript.shift() ?? text("fatto"))),
  });
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "capo@example.com", name: "Ivan" }).returning();
  userId = u!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1000", priceOutputPerMtok: "2000" })
    .returning();
  modelId = model!.id;
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

describe("turni del capo", () => {
  it("attivazione → turno → proponi_piano: voce plan in coda ed evento piano_proposto", async () => {
    const id = await seedTeam();
    const number = await activateAndPropose(id);

    const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, id));
    expect(instance).toMatchObject({ status: "active", activatedBy: userId });
    expect(instance!.lastTurnAt).not.toBeNull();

    const t = await turns(id);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: "done", reasons: [{ type: "activation" }], aiModelId: modelId, promptTokens: 20, completionTokens: 10, error: null });
    expect(Number(t[0]!.costUsd)).toBeCloseTo(0.04);
    const steps = await db.select().from(teamTurnStepsTable).where(eq(teamTurnStepsTable.turnId, t[0]!.id)).orderBy(teamTurnStepsTable.position);
    expect(steps.map((s) => [s.type, s.toolName, s.ok])).toEqual([
      ["model", null, true],
      ["tool", "proponi_piano", true],
      ["model", null, true],
    ]);

    const plan = await getPlan(id);
    expect(plan).toMatchObject({ status: "proposed", version: 2, approvedVersion: null, objective: "Chiudere il WI 1174", constraints: ["niente rilasci il venerdì"] });
    expect(plan.tasks).toMatchObject([{ id: "t1", title: "Analisi del WI", roleKey: "analista", status: "planned", outcome: null }]);

    const [item] = await items(id);
    expect(item).toMatchObject({ kind: "plan", planVersion: 2, userId, status: "pending", number, recipient: "Squadra WI" });
    const events = await listEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "piano_proposto" });
    expect(events[0]!.bulletin).toContain(`n. ${number}`);

    // Prompt: ruolo del capo e istruzioni d'uso nel sistema; PLAN e motivi come messaggi utente
    const [first, second] = leadRequests();
    expect(first!.messages[0]!.content).toContain("Coordina il lavoro sul WI.");
    expect(first!.messages[0]!.content).toContain("assegna_compito");
    expect(first!.messages[1]).toMatchObject({ role: "user" });
    expect(first!.messages[1]!.content).toContain("PLAN corrente (JSON)");
    expect(first!.messages[2]!.content).toContain("attivata");
    expect(first!.tools.map((x: { function: { name: string } }) => x.function.name)).toEqual([
      "leggi_piano",
      "proponi_piano",
      "aggiorna_piano",
      "assegna_compito",
      "leggi_esito",
      "segnala",
      "chiudi_lavoro",
    ]);
    expect(toolMessages(second!)[0]).toContain(`voce n. ${number}`);
  });

  it("approvazione → turno → assegna_compito → il compito riferisce → il turno successivo legge l'esito", async () => {
    const id = await seedTeam();
    const number = await activateAndPropose(id);

    leadScript.push(call("assegna_compito", { taskId: "t1" }), text("Compito assegnato."), text("Esito letto."));
    workerScript.push(call("riferisci", { status: "done", outcome: "WI analizzato: tre punti da chiudere" }));
    const decided = await approveAction(userId, number, {});
    expect(decided.ok).toBe(true);
    await settleAll();

    const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, id));
    expect(task).toMatchObject({ planTaskId: "t1", status: "done", outcome: "WI analizzato: tre punti da chiudere" });
    const t = await turns(id);
    expect(t.map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(t[1]!.reasons).toEqual([{ type: "decision", number, outcome: "approved", note: null }]);
    expect(t[2]!.reasons).toEqual([{ type: "task_finished", taskId: task!.id }]);
    const last = leadRequests().at(-1)!;
    expect(userMessages(last).some((m) => m.includes("Esito: WI analizzato: tre punti da chiudere"))).toBe(true);
    expect((await getPlan(id)).tasks[0]).toMatchObject({ status: "done", outcome: "WI analizzato: tre punti da chiudere" });
  });

  it("rifiuto con nota: il turno riceve la nota come messaggio utente separato, mai nel prompt di sistema", async () => {
    const id = await seedTeam();
    const number = await activateAndPropose(id);
    leadScript.push(text("Rivedo il piano."));
    const decided = await rejectAction(userId, number, "aggiungi un vincolo sul budget");
    expect(decided.ok).toBe(true);
    await settleAll();

    const last = leadRequests().at(-1)!;
    expect(userMessages(last)).toContain(`Nota dell'utente sul rifiuto della voce n. ${number}:\naggiungi un vincolo sul budget`);
    expect(last.messages[0]!.content).not.toContain("aggiungi un vincolo sul budget");
    expect((await getPlan(id)).status).toBe("draft");
  });

  it("assegna_compito fuori dal piano approvato: messaggio fisso al modello, nessun compito", async () => {
    const id = await seedTeam();
    await activateAndPropose(id);
    leadScript.push(call("assegna_compito", { taskId: "t1" }), text("Aspetto l'approvazione."));
    await sendToLead(userId, id, "parti subito con l'analisi");
    await settleAll();

    const [, , first, second] = leadRequests();
    expect(userMessages(first!)).toContain("Messaggio dell'utente:\nparti subito con l'analisi");
    expect(toolMessages(second!)).toEqual([TASK_MESSAGES.notInPlan]);
    expect(await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, id))).toHaveLength(0);
  });

  it("proponi_piano dopo l'approvazione: solo punti aperti → nessuna voce; compito nuovo → plan_change; una nuova proposta supera la precedente", async () => {
    const id = await seedTeam();
    const number = await activateAndPropose(id);
    leadScript.push(text("Piano approvato."));
    await approveAction(userId, number, {});
    await settleAll();
    const approved = await getPlan(id);
    expect(approved).toMatchObject({ status: "approved", version: 2, approvedVersion: 2 });

    const keepT1 = { id: "t1", title: "Analisi del WI", roleKey: "analista", instructions: "Analizza il WI 1174" };
    // Solo i punti aperti: nessuna voce, nessuna versione nuova
    leadScript.push(call("proponi_piano", { ...PROPOSAL, openPoints: ["chi approva il rilascio?"], tasks: [keepT1] }), text("ok"));
    await sendToLead(userId, id, "annota il dubbio sul rilascio");
    await settleAll();
    expect(await getPlan(id)).toMatchObject({ status: "approved", version: 2, openPoints: ["chi approva il rilascio?"] });
    expect(await items(id)).toHaveLength(1);

    // Un compito nuovo: modifica da approvare con le differenze
    leadScript.push(call("proponi_piano", { ...PROPOSAL, tasks: [keepT1, { title: "Test", roleKey: "analista", instructions: "Prova" }] }), text("ok"));
    await sendToLead(userId, id, "aggiungi i test");
    await settleAll();
    const afterChange = await items(id);
    expect(afterChange).toHaveLength(2);
    expect(afterChange[1]).toMatchObject({ kind: "plan_change", status: "pending", planVersion: 3 });
    expect(afterChange[1]!.summary).toContain("compiti aggiunti: t2 Test");
    expect(await getPlan(id)).toMatchObject({ status: "proposed", version: 3, approvedVersion: 2 });

    // Una nuova proposta mentre la precedente è in coda: la vecchia voce è rifiutata
    leadScript.push(call("proponi_piano", { ...PROPOSAL, tasks: [keepT1, { title: "Collaudo", roleKey: "analista", instructions: "Collauda" }] }), text("ok"));
    await sendToLead(userId, id, "meglio un collaudo");
    await settleAll();
    const latest = await items(id);
    expect(latest).toHaveLength(3);
    expect(latest[1]).toMatchObject({ status: "rejected", decisionNote: LEAD_MESSAGES.superseded });
    expect(latest[2]).toMatchObject({ kind: "plan_change", status: "pending", planVersion: 4 });
    expect((await getPlan(id)).tasks.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("un compito che finisce durante un turno: un solo turno in coda, che parte dopo", async () => {
    const id = await seedActiveApproved();
    const [running] = await db.insert(teamTurnsTable).values({ instanceId: id, status: "running", reasons: [{ type: "restart" }], startedAt: new Date() }).returning();

    workerScript.push(call("riferisci", { status: "done", outcome: "analisi pronta" }));
    const task = await startTask(id, "t1");
    await settleTaskExecutions();
    await sendToLead(userId, id, "come va?");
    await settleTurnExecutions();

    let t = await turns(id);
    expect(t.map((x) => x.status)).toEqual(["running", "queued"]);
    expect(t[1]!.reasons).toEqual([
      { type: "task_finished", taskId: task.id },
      { type: "request", text: "come va?" },
    ]);
    expect(leadRequests()).toHaveLength(0);

    leadScript.push(text("turno in corso chiuso"), text("esito letto"));
    await runTurn(running!.id);
    await settleAll();

    t = await turns(id);
    expect(t.map((x) => x.status)).toEqual(["done", "done"]);
    const last = leadRequests().at(-1)!;
    expect(userMessages(last).some((m) => m.includes("Esito: analisi pronta"))).toBe(true);
    expect(userMessages(last)).toContain("Messaggio dell'utente:\ncome va?");
  });

  it("chiusura: compiti in coda annullati, voci di piano rifiutate, nessun turno", async () => {
    const id = await seedActiveApproved();
    await db.insert(teamTasksTable).values({ instanceId: id, planTaskId: "t1", roleKey: "analista", instructions: "Analizza", status: "queued" });
    await patchPlan(id, { tasks: [{ id: "t1", status: "running" }] });
    const queuedItem = await enqueuePlanItem({ userId, instanceId: id, kind: "plan_change", planVersion: 2, recipient: "Squadra WI", summary: "modifica", detail: {} });
    expect(queuedItem.ok).toBe(true);
    await db.insert(teamTurnsTable).values({ instanceId: id, status: "queued", reasons: [{ type: "restart" }] });

    await closeInstance(id);

    const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, id));
    expect(task).toMatchObject({ status: "cancelled" });
    expect((await getPlan(id)).tasks[0]).toMatchObject({ status: "failed", outcome: "annullato: squadra chiusa" });
    expect((await items(id))[0]).toMatchObject({ status: "rejected", decisionNote: "squadra chiusa" });
    expect((await turns(id)).map((x) => [x.status, x.error])).toEqual([["failed", "squadra chiusa"]]);

    // Un motivo che arriva dopo la chiusura (es. un compito che finiva) non fa partire turni
    await enqueueTurnReason(id, { type: "request", text: "ci sei?" });
    await settleAll();
    expect((await turns(id)).map((x) => x.status)).toEqual(["failed", "failed"]);
    expect(chatCount()).toBe(0);
  });

  it("tetto della squadra raggiunto: turno failed, evento bloccato, nessuna chiamata al modello", async () => {
    const id = await seedActiveApproved({ monthlyBudgetUsd: "1.00" });
    await db.insert(teamTasksTable).values({ instanceId: id, planTaskId: "t0", roleKey: "analista", instructions: "", status: "done", costUsd: "1.500000", aiModelId: modelId });

    await sendToLead(userId, id, "vai avanti");
    await settleAll();

    const [turn] = await turns(id);
    expect(turn).toMatchObject({ status: "failed", error: TEAM_BUDGET_REACHED });
    const events = await listEvents(id);
    expect(events[0]).toMatchObject({ type: "bloccato" });
    expect(events[0]!.bulletin).toContain(TEAM_BUDGET_REACHED);
    expect(chatCount()).toBe(0);
  });
});
