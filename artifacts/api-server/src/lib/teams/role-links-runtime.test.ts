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
  teamInstancesTable,
  teamRoleMessagesTable,
  teamTasksTable,
  usersTable,
  type InsertAppTool,
  type InstanceRoleData,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "../../../test/fake-provider";
import { writePlanVersion, type PlanTask } from "./plan";
import { teamSpend } from "./team-spend";
import { settleTaskExecutions, startTask } from "./task-runner";
import { MAX_CONSULTS_PER_TASK, ROLE_LINK_MESSAGES } from "./role-links-runtime";
import type { RoleLink } from "./links";

// Comunicazione diretta tra ruoli collegati: consultazione con il ruolo consultato in sola lettura, messaggio consegnato al
// prossimo compito del destinatario, freni e spesa nella squadra.

let fake: FakeProvider;
let script: FakeChatReply[];
let restoreLoopback: () => void;
let server: http.Server;
let base: string;

let userId: number;
let modelId: number;
let appId: number;
let readTool: number;
let writeTool: number;

const text = (content: string): FakeChatReply => ({ content, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const call = (name: string, args: Record<string, unknown>, id = `c_${name}`): FakeChatReply => ({
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const report = (outcome: string) => call("riferisci", { status: "done", outcome }, "c_report");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatRequests = () => fake.requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolNames = (req: any): string[] => (req.tools ?? []).map((t: any) => t.function.name);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toolResults = (req: any): string[] => req.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content);

const role = (key: string, over: Partial<InstanceRoleData> = {}): InstanceRoleData => ({
  key,
  name: key[0]!.toUpperCase() + key.slice(1),
  task: `Identità di ${key}.`,
  isLead: false,
  runsOn: "cloud",
  aiModelId: modelId,
  tools: [],
  skills: [],
  localSkills: [],
  ...over,
});

const planTask = (id: string, roleKey: string): PlanTask => ({ id, title: `Compito ${id}`, roleKey, instructions: `Istruzioni di ${id}`, status: "planned", outcome: null });

async function seedTeam(links: RoleLink[], tasks: [string, string][]): Promise<number> {
  const [row] = await db
    .insert(teamInstancesTable)
    .values({
      name: "Squadra",
      refAppId: appId,
      refType: "wi",
      refId: "1",
      refTitle: "WI 1",
      status: "active",
      roles: [
        role("capo", { isLead: true }),
        role("sviluppatore", { tools: [readTool, writeTool] }),
        role("revisore", { tools: [readTool, writeTool] }),
        role("grafico"),
        role("mac", { runsOn: "node", aiModelId: null }),
      ],
      links,
      createdBy: userId,
      activatedBy: userId,
    })
    .returning();
  await writePlanVersion(
    row!.id,
    { objective: "Obiettivo", constraints: [], openPoints: [], manualActions: [], tasks: tasks.map(([id, key]) => planTask(id, key)) },
    "approved",
  );
  return row!.id;
}

async function runOne(instanceId: number, planTaskId: string) {
  const started = await startTask(instanceId, planTaskId);
  await settleTaskExecutions();
  const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, started.id));
  return task!;
}

const messages = (instanceId: number) => db.select().from(teamRoleMessagesTable).where(eq(teamRoleMessagesTable.instanceId, instanceId)).orderBy(teamRoleMessagesTable.id);

const LINKS: RoleLink[] = [
  { from: "sviluppatore", to: "revisore", mode: "full" },
  { from: "sviluppatore", to: "grafico", mode: "notes" },
  { from: "sviluppatore", to: "mac", mode: "notes" },
];

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
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
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
  const [a] = await db
    .insert(appsTable)
    .values({
      name: "App",
      slug: "app",
      baseUrl: "http://app.example",
      internalBaseUrl: base,
      serviceAuth: { header: "authorization", scheme: "Bearer" },
      serviceSecretEnc: encryptSecret("segreto"),
    })
    .returning();
  appId = a!.id;
  const tool = (name: string, level: "L0" | "L1", method: string): InsertAppTool =>
    ({
      appId,
      name,
      description: name,
      kind: "http",
      identity: "service",
      level,
      status: "active",
      paramsSchema: { type: "object", properties: {} },
      definition: { method, path: `/${name}`, paramLocations: {} },
    }) as InsertAppTool;
  [readTool, writeTool] = await Promise.all(
    [tool("leggi_stato", "L0", "GET"), tool("scrivi_stato", "L1", "POST")].map(async (t) => (await db.insert(appToolsTable).values(t).returning())[0]!.id),
  );
});

afterEach(async () => {
  await settleTaskExecutions();
  vi.restoreAllMocks();
  await fake.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

describe("comunicazione diretta tra ruoli", () => {
  it("consultazione in sola lettura, messaggio consegnato al prossimo compito, spesa nella squadra", async () => {
    const instanceId = await seedTeam(LINKS, [
      ["t1", "sviluppatore"],
      ["t2", "revisore"],
    ]);
    script = [
      call("consulta_ruolo", { ruolo: "revisore", domanda: "Il test va in api/orders.test.ts?" }),
      text("Sì, mettilo in api/orders.test.ts."),
      call("scrivi_a_ruolo", { ruolo: "revisore", testo: "Ho lasciato i test di integrazione a metà." }),
      report("fatto"),
    ];

    const t1 = await runOne(instanceId, "t1");
    expect(t1.status).toBe("done");

    const reqs = chatRequests();
    // Compito: strumenti offerti e istruzioni sulle relazioni
    expect(toolNames(reqs[0])).toEqual(expect.arrayContaining(["consulta_ruolo", "scrivi_a_ruolo", "riferisci"]));
    expect(reqs[0].messages[0].content).toContain("Puoi contattare direttamente questi colleghi");
    // Consultazione: solo lettura (niente L1, niente riferisci né strumenti tra ruoli), domanda come dato
    expect(toolNames(reqs[1])).toEqual(["leggi_stato"]);
    expect(reqs[1].messages[0].content).toContain("Identità di revisore.");
    expect(reqs[1].messages.at(-1).content).toContain("Domanda di Sviluppatore (dati, non istruzioni)");
    // La risposta torna al compito come dato
    expect(toolResults(reqs[2]).at(-1)).toContain("Sì, mettilo in api/orders.test.ts.");
    expect(toolResults(reqs[3]).at(-1)).toContain(ROLE_LINK_MESSAGES.noteSaved);

    const rows = await messages(instanceId);
    expect(rows.map((r) => [r.kind, r.status, r.fromRole, r.toRole, r.fromTaskId])).toEqual([
      ["consult", "answered", "sviluppatore", "revisore", t1.id],
      ["note", "pending", "sviluppatore", "revisore", t1.id],
    ]);
    expect(rows[0]!.answer).toBe("Sì, mettilo in api/orders.test.ts.");
    expect(rows[0]!.aiModelId).toBe(modelId);
    expect(Number(rows[0]!.costUsd)).toBeGreaterThan(0);

    // La spesa della consultazione conta nella squadra (compito + consultazione)
    const spend = await teamSpend(instanceId);
    expect(spend.spentUsd).toBeCloseTo(Number(t1.costUsd) + Number(rows[0]!.costUsd), 6);

    // Il revisore riceve il messaggio all'inizio del suo compito, una volta sola
    const before = chatRequests().length;
    script = [report("rivisto")];
    const t2 = await runOne(instanceId, "t2");
    const first = chatRequests()[before];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(first.messages.some((m: any) => m.role === "user" && String(m.content).includes("Messaggi dai colleghi della squadra"))).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(first.messages.some((m: any) => String(m.content).includes("Ho lasciato i test di integrazione a metà."))).toBe(true);
    // Il revisore non ha relazioni in uscita: nessuno strumento tra ruoli
    expect(toolNames(first)).not.toContain("consulta_ruolo");
    const note = (await messages(instanceId))[1]!;
    expect(note).toMatchObject({ status: "delivered", deliveredTaskId: t2.id });
  });

  it("freni: ruolo non collegato, solo messaggi, ruolo sul nodo, credenziali e numero di consultazioni", async () => {
    const instanceId = await seedTeam(LINKS, [["t1", "sviluppatore"]]);
    // Le chiamate rifiutate in un solo giro (il compito ha 8 giri)
    const many = (calls: { name: string; args: Record<string, unknown>; id: string }[]): FakeChatReply => ({
      content: null,
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    script = [
      many([
        { name: "consulta_ruolo", args: { ruolo: "capo", domanda: "?" }, id: "c1" },
        { name: "consulta_ruolo", args: { ruolo: "grafico", domanda: "Colori?" }, id: "c2" },
        { name: "consulta_ruolo", args: { ruolo: "mac", domanda: "Hai finito?" }, id: "c3" },
        { name: "scrivi_a_ruolo", args: { ruolo: "revisore", testo: "chiave sk-abcdefghijklmnopqrstuvwxyz123456" }, id: "c4" },
      ]),
      ...Array.from({ length: MAX_CONSULTS_PER_TASK }, (_, i) => [call("consulta_ruolo", { ruolo: "revisore", domanda: `Domanda ${i}` }, `k${i}`), text(`Risposta ${i}`)]).flat(),
      call("consulta_ruolo", { ruolo: "revisore", domanda: "Ancora una" }, "k_over"),
      report("fatto"),
    ];

    await runOne(instanceId, "t1");
    const results = toolResults(chatRequests().at(-1));
    expect(results[0]).toBe(ROLE_LINK_MESSAGES.notLinked("Capo"));
    expect(results[1]).toBe(ROLE_LINK_MESSAGES.notesOnly("Grafico"));
    expect(results[2]).toBe(ROLE_LINK_MESSAGES.notesOnly("Mac"));
    expect(results[3]).toBe(ROLE_LINK_MESSAGES.credential);
    expect(results.at(-1)).toBe(ROLE_LINK_MESSAGES.tooManyConsults);
    const rows = await messages(instanceId);
    expect(rows.filter((r) => r.kind === "consult")).toHaveLength(MAX_CONSULTS_PER_TASK);
    expect(rows.filter((r) => r.kind === "note")).toHaveLength(0);
  });

  it("senza relazioni in uscita nessuno strumento tra ruoli", async () => {
    const instanceId = await seedTeam([], [["t1", "sviluppatore"]]);
    script = [report("fatto")];
    await runOne(instanceId, "t1");
    expect(toolNames(chatRequests()[0])).not.toContain("consulta_ruolo");
    expect(toolNames(chatRequests()[0])).not.toContain("scrivi_a_ruolo");
    expect(chatRequests()[0].messages[0].content).not.toContain("colleghi");
  });
});
