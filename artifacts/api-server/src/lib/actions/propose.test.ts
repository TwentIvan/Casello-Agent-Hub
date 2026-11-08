import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
  type Agent,
  type App,
  type InsertAppTool,
  type Run,
} from "@workspace/db";
import { QUEUE_FAILED } from "../agent-loop";
import { decryptSecret } from "../secrets";
import type { CatalogTool } from "../tools/types";
import { MAX_PENDING_PER_USER, TOO_MANY_PENDING_MESSAGE } from "./queue";
import { PROPOSE_TOOL_NAME, handlePropose, proposalEligible, proposeTool } from "./propose";
import { PROPOSAL_MESSAGES } from "./proposal";

const saved = process.env["CASELLO_SECRET_KEY"];

let userId: number;
let app: App;
let agent: Agent;
let run: Run;
let tools: CatalogTool[];

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

async function insertTool(values: Partial<InsertAppTool> & { name: string }): Promise<CatalogTool> {
  const [row] = await db
    .insert(appToolsTable)
    .values({
      appId: app.id,
      kind: "http",
      identity: "service",
      level: "L2",
      status: "active",
      paramsSchema: { type: "object", properties: {} },
      definition: { method: "POST", path: `/${values.name}`, paramLocations: {} },
      ...values,
    } as InsertAppTool)
    .returning();
  return { ...row!, paramsSchema: row!.paramsSchema as Record<string, unknown>, definition: row!.definition as CatalogTool["definition"] };
}

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "a@example.com", name: "A" }).returning();
  userId = u!.id;
  [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" }).returning();
  [agent] = await db.insert(agentsTable).values({ appId: app.id, name: "Resp", role: "general", status: "active" }).returning();
  [run] = await db.insert(runsTable).values({ agentId: agent.id, input: "x" }).returning();
  tools = [
    await insertTool({ name: "create_project", paramsSchema: PROJECT_SCHEMA }),
    await insertTool({ name: "create_task", paramsSchema: TASK_SCHEMA }),
    await insertTool({ name: "user_tool", identity: "user" }),
  ];
});

afterEach(() => {
  if (saved === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, users RESTART IDENTITY CASCADE");
});

const owner = async (): Promise<number | null> => userId;
const propose = (args: Record<string, unknown>, o: () => Promise<number | null> = owner) =>
  handlePropose({ run, agent, app, tools, owner: o }, args);

const ARGS = {
  titolo: "Crea progetto e compito",
  motivo: "dalla mail",
  passi: [
    { id: "p1", strumento: "create_project", argomenti: { name: "Alfa", token: "segreto" }, sintesi: "Crea il progetto Alfa" },
    { id: "p2", strumento: "create_task", argomenti: { projectId: "{{p1.id}}", title: "Avvio" }, sintesi: "Crea il compito Avvio" },
  ],
};

describe("proposeTool e proposalEligible", () => {
  it("schema con titolo, motivo e passi", () => {
    const t = proposeTool();
    expect(t.name).toBe(PROPOSE_TOOL_NAME);
    expect((t.paramsSchema as any).required).toEqual(["titolo", "passi"]);
    expect(Object.keys((t.paramsSchema as any).properties)).toEqual(["titolo", "motivo", "passi"]);
  });

  it("idoneo: active, http|mcp, non L3, identità service", () => {
    const [p, , u] = tools as [CatalogTool, CatalogTool, CatalogTool];
    expect(proposalEligible(p)).toBe(true);
    expect(proposalEligible(u)).toBe(false);
    expect(proposalEligible({ ...p, status: "disabled" })).toBe(false);
    expect(proposalEligible({ ...p, kind: "ui" })).toBe(false);
    expect(proposalEligible({ ...p, level: "L1", levelOverride: "L3" })).toBe(false);
  });
});

describe("handlePropose", () => {
  it("accoda la voce proposal con i passi", async () => {
    const r = await propose(ARGS);
    expect(r.ok).toBe(true);
    const numero = (JSON.parse(r.content) as { numero: number }).numero;
    expect(JSON.parse(r.content)).toEqual({ ok: true, numero });

    const [row] = await db.select().from(pendingActionsTable);
    expect(row).toMatchObject({
      kind: "proposal",
      toolId: null,
      appId: app.id,
      runId: run.id,
      agentId: agent.id,
      summary: "Crea progetto e compito",
      recipient: "Mister",
      status: "pending",
      userId,
      number: numero,
    });
    const pub = row!.argsPublic as any;
    expect(pub.title).toBe("Crea progetto e compito");
    expect(pub.reason).toBe("dalla mail");
    expect(pub.steps[0]).toEqual({
      key: "p1",
      toolName: "create_project",
      args: { name: "Alfa", token: "***" },
      summary: "Crea il progetto Alfa",
    });
    expect(pub.steps[1].args).toEqual({ projectId: "{{p1.id}}", title: "Avvio" });
    expect(JSON.stringify(row!.argsPublic)).not.toContain("segreto");

    expect(JSON.parse(decryptSecret(row!.argsEnc!))).toEqual({
      title: "Crea progetto e compito",
      reason: "dalla mail",
      steps: [
        { key: "p1", toolName: "create_project", args: { name: "Alfa", token: "segreto" }, summary: "Crea il progetto Alfa" },
        { key: "p2", toolName: "create_task", args: { projectId: "{{p1.id}}", title: "Avvio" }, summary: "Crea il compito Avvio" },
      ],
    });

    const steps = await db.select().from(pendingActionStepsTable).orderBy(asc(pendingActionStepsTable.position));
    expect(steps.map((s) => [s.key, s.position, s.toolId, s.status, s.pendingActionId])).toEqual([
      ["p1", 0, tools[0]!.id, "pending", row!.id],
      ["p2", 1, tools[1]!.id, "pending", row!.id],
    ]);
  });

  it("strumento sconosciuto, non idoneo o con spazi: messaggio fisso o accettato", async () => {
    const bad = (strumento: string) => ({ ...ARGS, passi: [{ ...ARGS.passi[0]!, strumento }] });
    for (const name of ["nope", "user_tool"]) {
      const r = await propose(bad(name));
      expect(r).toEqual({ ok: false, content: `strumento ${name} non disponibile per le proposte` });
    }
    expect((await propose(bad(" create_project "))).ok).toBe(true);
    expect(await db.select().from(pendingActionsTable)).toHaveLength(1);
  });

  it("forma non valida: messaggio di parseProposalArgs", async () => {
    const r = await propose({ ...ARGS, titolo: "" });
    expect(r.ok).toBe(false);
    expect(r.content).toBe(PROPOSAL_MESSAGES.badTitle);
  });

  it("argomenti senza riferimenti che violano lo schema", async () => {
    const r = await propose({ ...ARGS, passi: [{ ...ARGS.passi[0]!, argomenti: { token: "x" } }] });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/^argomenti non validi nel passo p1: /);
    expect(await db.select().from(pendingActionsTable)).toHaveLength(0);
  });

  it("gli argomenti con riferimenti non si validano alla proposta", async () => {
    const r = await propose({
      ...ARGS,
      passi: [ARGS.passi[0], { ...ARGS.passi[1]!, argomenti: { projectId: "{{p1.id}}" } }],
    });
    expect(r.ok).toBe(true);
  });

  it("segnaposto nella sintesi → testo non pronto", async () => {
    const r = await propose({ ...ARGS, passi: [{ ...ARGS.passi[0]!, sintesi: "Crea [nome]" }] });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/^testo non pronto: /);
    expect(await db.select().from(pendingActionsTable)).toHaveLength(0);
  });

  it("seconda proposta nella stessa run con la prima pending", async () => {
    expect((await propose(ARGS)).ok).toBe(true);
    const r = await propose(ARGS);
    expect(r).toEqual({ ok: false, content: PROPOSAL_MESSAGES.alreadyProposed });
    expect(await db.select().from(pendingActionsTable)).toHaveLength(1);
  });

  it("una proposta già decisa non blocca la successiva", async () => {
    expect((await propose(ARGS)).ok).toBe(true);
    await db.update(pendingActionsTable).set({ status: "rejected" });
    expect((await propose(ARGS)).ok).toBe(true);
  });

  it("proprietario nullo → QUEUE_FAILED", async () => {
    const r = await propose(ARGS, async () => null);
    expect(r).toEqual({ ok: false, content: QUEUE_FAILED });
  });

  it("errore del DB nella lettura del proprietario → messaggio fisso", async () => {
    const r = await propose(ARGS, async () => {
      throw new Error("boom");
    });
    expect(r).toEqual({ ok: false, content: "proposta non riuscita: riprova più tardi" });
  });

  it("50 voci in attesa → limite", async () => {
    for (let n = 1; n <= MAX_PENDING_PER_USER; n++) {
      await db.insert(pendingActionsTable).values({
        userId,
        number: n,
        kind: "action",
        appId: app.id,
        toolId: tools[0]!.id,
        argsEnc: "x",
        argsPublic: {},
        recipient: "r",
        summary: "s",
      });
    }
    const r = await propose(ARGS);
    expect(r).toEqual({ ok: false, content: TOO_MANY_PENDING_MESSAGE });
    expect(await db.select().from(pendingActionStepsTable)).toHaveLength(0);
  });

  it("agente senza tool idonei: nessuno strumento disponibile", async () => {
    const r = await handlePropose({ run, agent, app, tools: [], owner }, ARGS);
    expect(r.ok).toBe(false);
  });
});
