import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  appsTable,
  appToolsTable,
  pendingActionsTable,
  pendingActionStepsTable,
  runsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { startFakeMcp, type FakeMcp, type FakeTool } from "../../../test/fake-mcp";
import { allowTestLoopback } from "../../../test/fake-provider";
import { approveAction, failInterruptedActions, rejectAction } from "./decide";
import { loadProposalSteps } from "./proposal-exec";
import type { ProposalStepInput } from "./proposal";
import { enqueueProposal } from "./queue";
import * as planDecisions from "../teams/plan-decisions";

vi.mock("../teams/plan-decisions", async (orig) => {
  const actual = await orig<typeof import("../teams/plan-decisions")>();
  return { ...actual, decidePlanItem: vi.fn(actual.decidePlanItem) };
});

const PROJECT_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, token: { type: "string", "x-sensitive": true } },
  required: ["name"],
};
const TASK_SCHEMA = {
  type: "object",
  properties: { projectId: { type: "integer" }, title: { type: "string" } },
  required: ["projectId", "title"],
};
const NOTE_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

const saved = process.env["CASELLO_SECRET_KEY"];
let restoreLoopback: () => void;
let fake: FakeMcp | null;
let userId: number;
let appId: number;
let agentId: number;
let runId: number;
const toolIds: Record<string, number> = {};

const DEFAULT_TOOLS: FakeTool[] = [
  { name: "create_project", text: '{"id":7,"name":"Alfa"}' },
  { name: "create_task", text: '{"id":11}' },
  { name: "add_note", text: "nota aggiunta" },
];

async function setup(tools: FakeTool[] = DEFAULT_TOOLS) {
  fake = await startFakeMcp({ tools });
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "a@example.com", name: "A" }).returning();
  userId = u!.id;
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      mcpUrl: fake.url,
      serviceAuth: { header: "X-Service-Key", scheme: null },
      serviceSecretEnc: encryptSecret("segreto-servizio"),
    })
    .returning();
  appId = app!.id;
  const [agent] = await db.insert(agentsTable).values({ appId, name: "Resp", role: "general", status: "active" }).returning();
  agentId = agent!.id;
  const [run] = await db.insert(runsTable).values({ agentId, input: "x" }).returning();
  runId = run!.id;
  for (const [name, schema] of [
    ["create_project", PROJECT_SCHEMA],
    ["create_task", TASK_SCHEMA],
    ["add_note", NOTE_SCHEMA],
  ] as const) {
    const [row] = await db
      .insert(appToolsTable)
      .values({
        appId,
        name,
        kind: "mcp",
        identity: "service",
        level: "L2",
        status: "active",
        paramsSchema: schema,
        definition: { mcpName: name },
      } as InsertAppTool)
      .returning();
    toolIds[name] = row!.id;
  }
}

async function propose(steps: Omit<ProposalStepInput, "key">[]): Promise<number> {
  const withKeys = steps.map((s, i) => ({ ...s, key: `p${i + 1}` }));
  const out = await enqueueProposal({
    userId,
    appId,
    agentId,
    runId,
    recipient: "Mister",
    proposal: { title: "Crea progetto e compiti", reason: null, steps: withKeys },
    publicProposal: { title: "Crea progetto e compiti" },
    steps: withKeys.map((s, i) => ({ key: s.key, position: i, toolId: toolIds[s.toolName]!, summary: s.summary })),
  });
  if (!out.ok) throw new Error(out.message);
  return out.number;
}

const THREE = [
  { toolName: "create_project", args: { name: "Alfa", token: "segreto-123" }, summary: "Crea il progetto Alfa" },
  { toolName: "create_task", args: { projectId: "{{p1.id}}", title: "Avvio" }, summary: "Crea il compito Avvio" },
  { toolName: "add_note", args: { text: "fatto" }, summary: "Aggiunge una nota" },
];

const rowOf = async (number: number) =>
  (await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, number)))[0]!;
const stepsOf = async (number: number) => {
  const row = await rowOf(number);
  return db
    .select()
    .from(pendingActionStepsTable)
    .where(eq(pendingActionStepsTable.pendingActionId, row.id))
    .orderBy(asc(pendingActionStepsTable.position));
};

beforeEach(() => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  restoreLoopback = allowTestLoopback();
  fake = null;
  vi.mocked(planDecisions.decidePlanItem).mockClear();
});

afterEach(async () => {
  restoreLoopback();
  await fake?.close();
  if (saved === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
});

describe("approvazione di una proposta", () => {
  it("approva tutto: il riferimento arriva come numero, voce e passi done", async () => {
    await setup();
    const n = await propose(THREE.slice(0, 2));

    const out = await approveAction(userId, n);

    expect(out.ok).toBe(true);
    expect(fake!.calls.map((c) => c.name)).toEqual(["create_project", "create_task"]);
    expect(fake!.calls[1]!.args).toEqual({ projectId: 7, title: "Avvio" });
    const row = await rowOf(n);
    expect(row).toMatchObject({ status: "done", result: "eseguiti 2 passi su 2", errorMessage: null, decidedBy: userId });
    expect(row.finishedAt).not.toBeNull();
    const steps = await stepsOf(n);
    expect(steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(steps[0]!.result).toBe('{"id":7,"name":"Alfa"}');
    expect(steps[1]!.result).toBe('{"id":11}');
    expect(steps.every((s) => s.finishedAt !== null)).toBe(true);
    expect(planDecisions.decidePlanItem).not.toHaveBeenCalled();
  });

  it("esclusione: p1 excluded, p2 (usa p1) skipped, p3 done", async () => {
    await setup();
    const n = await propose(THREE);

    const out = await approveAction(userId, n, { exclude: ["p1"] });

    expect(out.ok && out.action).toMatchObject({ status: "done", result: "eseguiti 1 passi su 1" });
    expect((await stepsOf(n)).map((s) => s.status)).toEqual(["excluded", "skipped", "done"]);
    expect(fake!.calls.map((c) => c.name)).toEqual(["add_note"]);
  });

  it("esclusioni non valide o tutte escluse: 400 e voce ancora pending", async () => {
    await setup();
    const n = await propose(THREE);

    const bad = { ok: false, status: 400, message: "passi da escludere non validi" };
    expect(await approveAction(userId, n, { exclude: ["p1", "p1"] })).toEqual(bad);
    expect(await approveAction(userId, n, { exclude: ["p9"] })).toEqual(bad);
    expect(await approveAction(userId, n, { exclude: ["p1", "p3"] })).toEqual({
      ok: false,
      status: 400,
      message: "nessun passo da eseguire: rifiuta la proposta",
    });
    expect((await rowOf(n)).status).toBe("pending");
    expect((await stepsOf(n)).every((s) => s.status === "pending")).toBe(true);
    expect(fake!.calls).toHaveLength(0);
  });

  it("errore al passo 2 di 3: p1 done, p2 failed col messaggio del tool, p3 not_run, voce failed", async () => {
    await setup([
      DEFAULT_TOOLS[0]!,
      { name: "create_task", text: "progetto chiuso", isError: true },
      DEFAULT_TOOLS[2]!,
    ]);
    const n = await propose(THREE);

    const out = await approveAction(userId, n);

    expect(out.ok && out.action).toMatchObject({
      status: "failed",
      errorMessage: "eseguiti 1 passi su 3: si è fermata al passo p2",
    });
    const steps = await stepsOf(n);
    expect(steps.map((s) => s.status)).toEqual(["done", "failed", "not_run"]);
    expect(steps[1]!.errorMessage).toBe("progetto chiuso");
    expect(steps[1]!.finishedAt).not.toBeNull();
    expect(fake!.calls.map((c) => c.name)).toEqual(["create_project", "create_task"]);
  });

  it("riferimento a un campo assente o risultato non JSON: passo failed «riferimento non risolto»", async () => {
    await setup();
    const n = await propose([
      THREE[0]!,
      { toolName: "create_task", args: { projectId: "{{p1.code}}", title: "Avvio" }, summary: "Crea il compito" },
    ]);
    const out = await approveAction(userId, n);
    expect(out.ok && out.action).toMatchObject({ status: "failed", errorMessage: "eseguiti 1 passi su 2: si è fermata al passo p2" });
    expect((await stepsOf(n))[1]).toMatchObject({ status: "failed", errorMessage: "riferimento non risolto" });

    const m = await propose([
      THREE[2]!,
      { toolName: "create_task", args: { projectId: "{{p1.id}}", title: "Avvio" }, summary: "Crea il compito" },
    ]);
    await approveAction(userId, m);
    expect((await stepsOf(m))[1]).toMatchObject({ status: "failed", errorMessage: "riferimento non risolto" });
    expect(fake!.calls.filter((c) => c.name === "create_task")).toHaveLength(0);
  });

  it("tool del passo 2 non più usabile (disattivato, L3, identità user): failed «strumento non più utilizzabile»", async () => {
    await setup();
    const changes: Partial<InsertAppTool>[] = [{ status: "disabled" }, { levelOverride: "L3" }, { identity: "user" }];
    for (const change of changes) {
      const n = await propose(THREE);
      await db.update(appToolsTable).set(change).where(eq(appToolsTable.id, toolIds["create_task"]!));

      const out = await approveAction(userId, n);

      expect(out.ok && out.action.status).toBe("failed");
      const steps = await stepsOf(n);
      expect(steps.map((s) => s.status)).toEqual(["done", "failed", "not_run"]);
      expect(steps[1]!.errorMessage).toBe("strumento non più utilizzabile");
      await db
        .update(appToolsTable)
        .set({ status: "active", levelOverride: null, identity: "service" })
        .where(eq(appToolsTable.id, toolIds["create_task"]!));
    }
    expect(fake!.calls.filter((c) => c.name === "create_task")).toHaveLength(0);
  });

  it("valore x-sensitive dell'argomento: non compare nel result del passo", async () => {
    await setup([{ name: "create_project", text: '{"id":7,"token":"segreto-123"}' }, ...DEFAULT_TOOLS.slice(1)]);
    const n = await propose(THREE.slice(0, 1));

    await approveAction(userId, n);

    const [step] = await stepsOf(n);
    expect(step!.result).toBe('{"id":7,"token":"***"}');
    expect(fake!.calls[0]!.args).toEqual({ name: "Alfa", token: "segreto-123" });
  });

  it("risultato oltre 20 000 caratteri: il riferimento si risolve, il result salvato è troncato", async () => {
    const long = JSON.stringify({ id: 7, pad: "x".repeat(30_000) });
    await setup([{ name: "create_project", text: long }, ...DEFAULT_TOOLS.slice(1)]);
    const n = await propose(THREE.slice(0, 2));

    const out = await approveAction(userId, n);

    expect(out.ok && out.action.status).toBe("done");
    expect(fake!.calls[1]!.args).toEqual({ projectId: 7, title: "Avvio" });
    const [p1] = await stepsOf(n);
    expect(p1!.result!.startsWith('{"id":7,')).toBe(true);
    expect(p1!.result!.length).toBeLessThan(long.length);
    expect(p1!.result!.length).toBeLessThanOrEqual(20_000 + 60);
  });

  it("due approvazioni concorrenti: una sola esegue, l'altra 409", async () => {
    await setup();
    const n = await propose(THREE.slice(0, 2));

    const results = await Promise.all([approveAction(userId, n), approveAction(userId, n)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, status: 409, message: "azione già decisa" });
    expect(fake!.calls).toHaveLength(2);
  });

  it("loadProposalSteps raggruppa i passi per voce in ordine di posizione", async () => {
    await setup();
    const n = await propose(THREE);
    const id = (await rowOf(n)).id;
    const map = await loadProposalSteps([id]);
    expect(map.get(id)!.map((s) => s.key)).toEqual(["p1", "p2", "p3"]);
    expect((await loadProposalSteps([])).size).toBe(0);
  });
});

describe("rifiuto di una proposta", () => {
  it("rejected con la nota, passi invariati, decidePlanItem mai chiamato", async () => {
    await setup();
    const n = await propose(THREE);

    const out = await rejectAction(userId, n, "non ora");

    expect(out.ok).toBe(true);
    expect(await rowOf(n)).toMatchObject({ status: "rejected", decisionNote: "non ora", decidedBy: userId });
    expect((await stepsOf(n)).every((s) => s.status === "pending")).toBe(true);
    expect(planDecisions.decidePlanItem).not.toHaveBeenCalled();
    expect(fake!.calls).toHaveLength(0);
  });
});

describe("failInterruptedActions con le proposte", () => {
  it("proposta executing: voce failed incerta, passo done invariato, passo pending → not_run", async () => {
    await setup();
    const n = await propose(THREE.slice(0, 2));
    const row = await rowOf(n);
    await db.update(pendingActionsTable).set({ status: "executing" }).where(eq(pendingActionsTable.id, row.id));
    const [p1] = await stepsOf(n);
    await db
      .update(pendingActionStepsTable)
      .set({ status: "done", result: '{"id":7}', finishedAt: new Date() })
      .where(eq(pendingActionStepsTable.id, p1!.id));

    expect(await failInterruptedActions()).toBe(1);

    expect(await rowOf(n)).toMatchObject({ status: "failed", errorMessage: "esito incerto: verifica sul servizio" });
    const steps = await stepsOf(n);
    expect(steps.map((s) => s.status)).toEqual(["done", "not_run"]);
    expect(steps[0]!.result).toBe('{"id":7}');
  });
});
