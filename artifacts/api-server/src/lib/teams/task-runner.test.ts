import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  appToolsTable,
  pendingActionsTable,
  teamEventsTable,
  teamInstancesTable,
  teamTaskStepsTable,
  teamTasksTable,
  teamTurnsTable,
  usersTable,
  type InsertAppTool,
  type InstanceRoleData,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { modelSpends, userSpend } from "../budget";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "../../../test/fake-provider";
import { startFakeMcp, type FakeMcp } from "../../../test/fake-mcp";
import { getPlan, writePlanVersion, type PlanTask } from "./plan";
import { listEvents, markRead, unreadBulletin } from "./events";
import { loadRoleTools } from "./role-tools";
import { teamBudgetBlock, teamSpend, TEAM_BUDGET_REACHED } from "./team-budget";
import { MAX_RUNNING_TASKS, TASK_MESSAGES, failInterruptedTeamWork, settleTaskExecutions, startTask } from "./task-runner";

// Compiti dei ruoli cloud: finto provider per il modello, una finta app HTTP per app e un finto server MCP

let fake: FakeProvider;
let mcp: FakeMcp;
let script: FakeChatReply[];
let restoreLoopback: () => void;

interface AppServer {
  server: http.Server;
  base: string;
  requests: { method: string; url: string; auth: string | undefined; body: string }[];
}
let appA: AppServer;

let userId: number;
let modelId: number;
let appAId: number;
let appBId: number;

async function startApp(name: string): Promise<AppServer> {
  const requests: AppServer["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ app: name, stato: "aperto" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, requests };
}

async function stopApp(app: AppServer): Promise<void> {
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
}

const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const report = (outcome: string, status = "done", detail?: string) => call("riferisci", { status, outcome, ...(detail ? { detail } : {}) }, "c_report");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatRequests = () => fake.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as any);

const READ_WI = (appId: number): InsertAppTool =>
  ({
    appId,
    name: "leggi_wi",
    description: "Legge un work item",
    kind: "http",
    identity: "service",
    level: "L0",
    status: "active",
    paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    definition: { method: "GET", path: "/wi/{id}", paramLocations: { id: "path" } },
  }) as InsertAppTool;

async function insertTool(tool: InsertAppTool): Promise<number> {
  const [row] = await db.insert(appToolsTable).values(tool).returning();
  return row!.id;
}

const cloudRole = (tools: number[], over: Partial<InstanceRoleData> = {}): InstanceRoleData => ({
  key: "analista",
  name: "Analista",
  task: "Analizza i work item.",
  isLead: false,
  runsOn: "cloud",
  aiModelId: modelId,
  tools,
  skills: [],
  localSkills: [],
  ...over,
});
const lead = (): InstanceRoleData => ({ ...cloudRole([]), key: "capo", name: "Capo", isLead: true });

const planTask = (id: string, roleKey = "analista"): PlanTask => ({
  id,
  title: `Compito ${id}`,
  roleKey,
  instructions: `Istruzioni di ${id}`,
  status: "planned",
  outcome: null,
});

/** Squadra attiva con il PLAN approvato che contiene i compiti indicati. */
async function seedTeam(roles: InstanceRoleData[], taskIds: string[] = ["t1"], over: { monthlyBudgetUsd?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(teamInstancesTable)
    .values({
      name: "Squadra WI",
      refAppId: appAId,
      refType: "wi",
      refId: "1174",
      refTitle: "WI 1174",
      status: "active",
      roles: [lead(), ...roles],
      createdBy: userId,
      activatedBy: userId,
      ...(over.monthlyBudgetUsd ? { monthlyBudgetUsd: over.monthlyBudgetUsd } : {}),
    })
    .returning();
  await writePlanVersion(
    row!.id,
    {
      objective: "Chiudere il WI",
      constraints: [],
      openPoints: [],
      manualActions: [],
      tasks: taskIds.map((id) => planTask(id, id === "tn" ? "operaio-nodo" : "analista")),
    },
    "approved",
  );
  return row!.id;
}

async function runOne(instanceId: number, planTaskId = "t1") {
  const started = await startTask(instanceId, planTaskId);
  await settleTaskExecutions();
  const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, started.id));
  return task!;
}

const steps = (taskId: number) => db.select().from(teamTaskStepsTable).where(eq(teamTaskStepsTable.taskId, taskId)).orderBy(teamTaskStepsTable.position);
const turns = (instanceId: number) => db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("condizione non raggiunta in tempo");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(async () => {
  restoreLoopback();
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
});

const savedKey = process.env["CASELLO_SECRET_KEY"];

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  script = [];
  fake = await startFakeProvider({ chatReply: () => script.shift() ?? text("fatto") });
  mcp = await startFakeMcp({ tools: [{ name: "leggi_wi", text: "WI dal server MCP" }] });
  appA = await startApp("A");
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
  const service = { serviceAuth: { header: "authorization", scheme: "Bearer" }, serviceSecretEnc: encryptSecret("segreto-servizio") };
  const [a] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "http://hub.example", internalBaseUrl: appA.base, ...service }).returning();
  const [b] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example", mcpUrl: mcp.url, ...service })
    .returning();
  appAId = a!.id;
  appBId = b!.id;
});

afterEach(async () => {
  await settleTaskExecutions();
  vi.restoreAllMocks();
  await fake.close();
  await mcp.close();
  await stopApp(appA);
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

describe("compiti dei ruoli cloud", () => {
  it("strumento di un'app poi riferisci: done, esito nel PLAN, evento e turno del capo in coda", async () => {
    const tool = await insertTool(READ_WI(appAId));
    const instanceId = await seedTeam([cloudRole([tool])]);
    script = [call("leggi_wi", { id: "1174" }), report("WI 1174 analizzato", "done", "dettaglio lungo")];

    const task = await runOne(instanceId);

    expect(task).toMatchObject({ status: "done", outcome: "WI 1174 analizzato", detail: "dettaglio lungo", error: null, promptTokens: 20, completionTokens: 10 });
    expect(task.finishedAt).not.toBeNull();
    expect(appA.requests).toHaveLength(1);
    expect(appA.requests[0]).toMatchObject({ method: "GET", url: "/api/wi/1174", auth: "Bearer segreto-servizio" });

    const plan = await getPlan(instanceId);
    expect(plan.tasks[0]).toMatchObject({ id: "t1", status: "done", outcome: "WI 1174 analizzato" });
    const events = await listEvents(instanceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "compito_finito", taskId: task.id });
    expect(events[0]!.bulletin).toContain("WI 1174 analizzato");
    const t = await turns(instanceId);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: "queued", reasons: [{ type: "task_finished", taskId: task.id }] });

    expect((await steps(task.id)).map((s) => [s.type, s.toolName, s.ok])).toEqual([
      ["model", null, true],
      ["tool", "leggi_wi", true],
      ["model", null, true],
      ["tool", "riferisci", true],
    ]);

    // Prompt del ruolo nel sistema; PLAN e compito come messaggio utente; nessun indirizzo delle app
    const first = chatRequests()[0];
    expect(first.messages[0].role).toBe("system");
    expect(first.messages[0].content).toContain("Analizza i work item.");
    expect(first.messages[1].role).toBe("user");
    expect(first.messages[1].content).toContain("Istruzioni di t1");
    expect(first.messages[1].content).toContain("Chiudere il WI");
    expect(JSON.stringify(first.messages)).not.toContain("127.0.0.1");
    expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["leggi_wi", "riferisci"]);
  });

  it("due leggi_wi di app diverse: nomi distinti, ciascuno chiama la sua app", async () => {
    const httpTool = await insertTool(READ_WI(appAId));
    const mcpTool = await insertTool({
      appId: appBId,
      name: "leggi_wi",
      kind: "mcp",
      identity: "service",
      level: "L0",
      status: "active",
      paramsSchema: { type: "object", properties: { id: { type: "string" } } },
      definition: { mcpName: "leggi_wi" },
    } as InsertAppTool);
    const instanceId = await seedTeam([cloudRole([httpTool, mcpTool])]);
    script = [call(`leggi_wi_${appBId}`, { id: "7" }, "c1"), call(`leggi_wi_${appAId}`, { id: "8" }, "c2"), report("letti entrambi")];

    const task = await runOne(instanceId);

    expect(task.status).toBe("done");
    expect(chatRequests()[0].tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([`leggi_wi_${appAId}`, `leggi_wi_${appBId}`, "riferisci"]);
    expect(mcp.calls).toHaveLength(1);
    expect(mcp.calls[0]).toMatchObject({ name: "leggi_wi", args: { id: "7" } });
    expect(appA.requests.map((r) => r.url)).toEqual(["/api/wi/8"]);
    expect(mcp.calls[0]!.headers["authorization"]).toBe("Bearer segreto-servizio");
  });

  it("tool di un'app chiamato riferisci: esposto come riferisci_<appId>, chiama l'app e non chiude il compito", async () => {
    const tool = await insertTool({ ...READ_WI(appAId), name: "riferisci", definition: { method: "POST", path: "/report", paramLocations: { id: "body" } } } as InsertAppTool);
    const role = await loadRoleTools([tool]);
    expect([...role.nameMap.keys()]).toEqual([`riferisci_${appAId}`]);
    const instanceId = await seedTeam([cloudRole([tool])]);
    script = [call(`riferisci_${appAId}`, { id: "1" }, "c1"), report("chiuso davvero")];

    const task = await runOne(instanceId);

    expect(appA.requests).toHaveLength(1);
    expect(appA.requests[0]).toMatchObject({ method: "POST", url: "/api/report" });
    expect(task).toMatchObject({ status: "done", outcome: "chiuso davvero" });
    expect(chatRequests()[0].tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([`riferisci_${appAId}`, "riferisci"]);
  });

  it("strumento L2: voce action in coda con team_instance_id e utente che ha attivato la squadra", async () => {
    const tool = await insertTool({
      ...READ_WI(appAId),
      name: "invia_riepilogo",
      level: "L2",
      definition: { method: "POST", path: "/send", paramLocations: { id: "body" } },
    } as InsertAppTool);
    const instanceId = await seedTeam([cloudRole([tool])]);
    script = [call("invia_riepilogo", { id: "1174", destinatario: "Mario Rossi", sintesi: "Invia a Mario il riepilogo del WI 1174" }), report("riepilogo in coda")];

    const task = await runOne(instanceId);

    expect(task.status).toBe("done");
    expect(appA.requests).toHaveLength(0);
    const queued = await db.select().from(pendingActionsTable);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "action",
      userId,
      appId: appAId,
      toolId: tool,
      teamInstanceId: instanceId,
      agentId: null,
      runId: null,
      recipient: "Mario Rossi",
      status: "pending",
    });
    expect((await steps(task.id))[1]).toMatchObject({ type: "queued", toolName: "invia_riepilogo" });
  });

  it("senza riferisci: done con l'ultimo messaggio troncato a 300 caratteri", async () => {
    const instanceId = await seedTeam([cloudRole([])]);
    const long = "x".repeat(450);
    script = [text(long)];

    const task = await runOne(instanceId);

    expect(task.status).toBe("done");
    expect(task.outcome).toBe("x".repeat(300));
    expect(task.detail).toBe(long);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "done", outcome: "x".repeat(300) });
  });

  it("limite di giri: failed con il motivo, evento bloccato", async () => {
    const tool = await insertTool(READ_WI(appAId));
    const instanceId = await seedTeam([cloudRole([tool])]);
    fake.chatReply = () => call("leggi_wi", { id: "1" });

    const task = await runOne(instanceId);

    expect(task.status).toBe("failed");
    expect(task.error).toBe("limite di 8 giri di strumenti raggiunto");
    expect(appA.requests).toHaveLength(8);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "failed", outcome: "limite di 8 giri di strumenti raggiunto" });
    expect((await listEvents(instanceId))[0]).toMatchObject({ type: "bloccato", taskId: task.id });
  });

  it("4 compiti: 3 running e 1 queued, che parte alla fine di uno", async () => {
    const instanceId = await seedTeam([cloudRole([])], ["t1", "t2", "t3", "t4"]);
    fake.delayMs = 300;
    fake.chatReply = () => report("fatto");
    const count = async (status: "running" | "queued" | "done") =>
      (await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, instanceId))).filter((t) => t.status === status).length;

    for (const id of ["t1", "t2", "t3", "t4"]) await startTask(instanceId, id);
    await waitFor(async () => (await count("running")) === MAX_RUNNING_TASKS);
    expect(await count("queued")).toBe(1);

    await settleTaskExecutions();
    expect(await count("done")).toBe(4);
    const all = await db.select().from(teamTasksTable).where(eq(teamTasksTable.instanceId, instanceId)).orderBy(teamTasksTable.id);
    // Il quarto parte solo dopo la fine di uno dei primi tre
    const firstEnd = Math.min(...all.slice(0, 3).map((t) => t.finishedAt!.getTime()));
    expect(all[3]!.startedAt!.getTime()).toBeGreaterThanOrEqual(firstEnd);
  });

  it("ruolo node: waiting_node senza chiamate al modello", async () => {
    const instanceId = await seedTeam([cloudRole([]), { ...cloudRole([]), key: "operaio-nodo", name: "Operaio", runsOn: "node", aiModelId: null }], ["t1", "tn"]);

    const task = await runOne(instanceId, "tn");

    expect(task).toMatchObject({ status: "waiting_node", aiModelId: null, startedAt: null });
    expect(chatRequests()).toHaveLength(0);
    expect((await getPlan(instanceId)).tasks.find((t) => t.id === "tn")).toMatchObject({ status: "waiting_node" });
  });

  it("compito fuori dal PLAN approvato: rifiutato con il messaggio fisso", async () => {
    const instanceId = await seedTeam([cloudRole([])]);
    await expect(startTask(instanceId, "t99")).rejects.toThrow(TASK_MESSAGES.notInPlan);
  });

  it("tetto della squadra raggiunto: blocked ed evento, nessuna chiamata al modello", async () => {
    const instanceId = await seedTeam([cloudRole([])], ["t1"], { monthlyBudgetUsd: "1.00" });
    await db.insert(teamTasksTable).values({ instanceId, planTaskId: "t0", roleKey: "analista", instructions: "", status: "done", costUsd: "1.500000", aiModelId: modelId });
    expect((await teamSpend(instanceId)).spentUsd).toBeCloseTo(1.5);
    expect(await teamBudgetBlock(instanceId, modelId)).toBe(TEAM_BUDGET_REACHED);

    const task = await runOne(instanceId);

    expect(task).toMatchObject({ status: "blocked", outcome: TEAM_BUDGET_REACHED });
    expect(chatRequests()).toHaveLength(0);
    const events = await listEvents(instanceId);
    expect(events[0]).toMatchObject({ type: "bloccato", taskId: task.id });
    expect(events[0]!.bulletin).toContain(TEAM_BUDGET_REACHED);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "blocked", outcome: TEAM_BUDGET_REACHED });
  });

  it("la spesa di compiti e turni conta in userSpend e modelSpends", async () => {
    const instanceId = await seedTeam([cloudRole([])]);
    script = [report("fatto")];
    const task = await runOne(instanceId);
    // 10 token di prompt a 1000 $/M + 5 di completamento a 2000 $/M
    expect(Number(task.costUsd)).toBeCloseTo(0.02);
    await db.insert(teamTurnsTable).values({ instanceId, status: "done", aiModelId: modelId, costUsd: "0.500000", promptTokens: 1, completionTokens: 1 });
    await db.insert(teamTurnsTable).values({ instanceId, status: "failed", aiModelId: modelId, costUsd: null, promptTokens: 5, completionTokens: 1 });

    const user = await userSpend(userId);
    expect(user.spentUsd).toBeCloseTo(0.52);
    expect(user.unpricedCount).toBe(1);
    expect((await modelSpends([modelId])).get(modelId)!.spentUsd).toBeCloseTo(0.52);
    expect((await teamSpend(instanceId)).spentUsd).toBeCloseTo(0.52);
  });

  it("riavvio: compiti e turni running → failed, eventi interrotto, turno restart", async () => {
    const instanceId = await seedTeam([cloudRole([])]);
    const [running] = await db.insert(teamTasksTable).values({ instanceId, planTaskId: "t1", roleKey: "analista", instructions: "", status: "running" }).returning();
    await db.insert(teamTurnsTable).values({ instanceId, status: "running" });

    await failInterruptedTeamWork();

    const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, running!.id));
    expect(task).toMatchObject({ status: "failed", error: TASK_MESSAGES.interrupted });
    const t = await turns(instanceId);
    expect(t.find((x) => x.status === "failed")).toMatchObject({ error: TASK_MESSAGES.interrupted });
    expect(t.find((x) => x.status === "queued")).toMatchObject({ reasons: [{ type: "restart" }] });
    const events = await listEvents(instanceId);
    expect(events.map((e) => e.type)).toEqual(["interrotto", "interrotto"]);
    expect((await getPlan(instanceId)).tasks[0]).toMatchObject({ status: "failed", outcome: TASK_MESSAGES.interrupted });

    // Bollettino dell'utente che ha attivato la squadra
    expect(await unreadBulletin(userId)).toHaveLength(2);
    expect(await markRead(userId, events.map((e) => e.id))).toBe(2);
    expect(await unreadBulletin(userId)).toHaveLength(0);
    expect(await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId))).toHaveLength(2);
  });

  it("argomenti x-sensitive oscurati in team_task_steps", async () => {
    const tool = await insertTool({
      ...READ_WI(appAId),
      name: "accedi",
      paramsSchema: { type: "object", properties: { id: { type: "string" }, password: { type: "string", "x-sensitive": true } }, required: ["id"] },
      definition: { method: "POST", path: "/login", paramLocations: { id: "body", password: "body" } },
    } as InsertAppTool);
    const instanceId = await seedTeam([cloudRole([tool])]);
    script = [call("accedi", { id: "1", password: "parola-segreta-123" }), report("accesso fatto")];

    const task = await runOne(instanceId);

    expect(appA.requests[0]!.body).toContain("parola-segreta-123");
    expect((await steps(task.id))[1]!.args).toEqual({ id: "1", password: "***" });
    const all = await pool.query("select row_to_json(s)::text as j from team_task_steps s");
    for (const row of all.rows) expect(row.j).not.toContain("parola-segreta-123");
  });
});
