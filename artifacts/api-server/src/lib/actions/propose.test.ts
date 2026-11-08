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
import { loadProposalSteps } from "./proposal-exec";
import { toProposalView } from "./proposal-view";
import { previewExclusion } from "../teams/centralino";

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

const P3 = { id: "p3", strumento: "create_task", argomenti: { projectId: 5, title: "Altro" }, sintesi: "Crea il compito Altro" };

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
      refs: [],
      summary: "Crea il progetto Alfa",
    });
    expect(pub.steps[1].args).toEqual({ projectId: "{{p1.id}}", title: "Avvio" });
    expect(pub.steps[1].refs).toEqual([{ param: "projectId", step: "p1", field: ["id"] }]);
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

  it("destinatario e sintesi negli argomenti (campi della coda L2) si tolgono prima di salvare", async () => {
    const extra = { destinatario: "Ivan", sintesi: "Crea il progetto" };
    const r = await propose({
      ...ARGS,
      passi: [
        { ...ARGS.passi[0]!, argomenti: { ...ARGS.passi[0]!.argomenti, ...extra } },
        { ...ARGS.passi[1]!, argomenti: { ...ARGS.passi[1]!.argomenti, ...extra } },
      ],
    });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(pendingActionsTable);
    const saved = JSON.parse(decryptSecret(row!.argsEnc!)) as { steps: { args: Record<string, unknown> }[] };
    expect(saved.steps.map((s) => s.args)).toEqual([
      { name: "Alfa", token: "segreto" },
      { projectId: "{{p1.id}}", title: "Avvio" },
    ]);
    expect((row!.argsPublic as any).steps.map((s: any) => s.args)).toEqual([
      { name: "Alfa", token: "***" },
      { projectId: "{{p1.id}}", title: "Avvio" },
    ]);
  });

  it("destinatario dichiarato dallo schema del tool: resta", async () => {
    const mail = await insertTool({
      name: "send_mail",
      paramsSchema: { type: "object", properties: { destinatario: { type: "string" }, text: { type: "string" } }, required: ["destinatario"] },
    });
    tools = [...tools, mail];
    const r = await propose({
      titolo: "Mail",
      passi: [{ id: "p1", strumento: "send_mail", argomenti: { destinatario: "Ivan", sintesi: "x", text: "ciao" }, sintesi: "Manda la mail" }],
    });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(pendingActionsTable);
    const saved = JSON.parse(decryptSecret(row!.argsEnc!)) as { steps: { args: Record<string, unknown> }[] };
    expect(saved.steps[0]!.args).toEqual({ destinatario: "Ivan", text: "ciao" });
  });

  it("parametri non previsti dallo schema, anche con riferimenti: rifiutati alla proposta", async () => {
    const r1 = await propose({ ...ARGS, passi: [{ ...ARGS.passi[0]!, argomenti: { name: "Alfa", owner: "x", role: 1 } }] });
    expect(r1).toEqual({ ok: false, content: "parametri non previsti nel passo p1: owner, role" });
    const r2 = await propose({
      ...ARGS,
      passi: [ARGS.passi[0], { ...ARGS.passi[1]!, argomenti: { projectId: "{{p1.id}}", title: "Avvio", parent: "{{p1.id}}" } }],
    });
    expect(r2).toEqual({ ok: false, content: "parametri non previsti nel passo p2: parent" });
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

  it("segnaposto nel motivo → testo non pronto", async () => {
    const r = await propose({ ...ARGS, motivo: "Richiesta di [cliente]" });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/^testo non pronto: /);
    expect(await db.select().from(pendingActionsTable)).toHaveLength(0);
  });

  it("riferimento dentro un parametro x-sensitive: refs salvati senza valori, vista e anteprima di Alfred li usano", async () => {
    const r = await propose({
      ...ARGS,
      passi: [ARGS.passi[0], { id: "p2", strumento: "create_project", argomenti: { name: "Beta", token: "{{p1.id}}" }, sintesi: "Crea il progetto Beta" }, P3],
    });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(pendingActionsTable);
    const pub = row!.argsPublic as { steps: { args: unknown; refs: unknown }[] };
    expect(pub.steps[1]!.args).toEqual({ name: "Beta", token: "***" });
    expect(pub.steps[0]!.refs).toEqual([]);
    expect(pub.steps[1]!.refs).toEqual([{ param: "token", step: "p1", field: ["id"] }]);

    const steps = (await loadProposalSteps([row!.id])).get(row!.id)!;
    const view = toProposalView(row!, steps, new Map());
    expect(view!.steps[1]!.refs).toEqual([{ param: "token", step: "p1", field: ["id"] }]);
    expect(await previewExclusion(userId, row!.number, ["p1"])).toEqual({ excluded: ["p1"], skipped: ["p2"] });
  });

  it("voce vecchia senza refs salvati: i riferimenti si ricalcolano dagli argomenti pubblici", async () => {
    expect((await propose({ ...ARGS, passi: [...ARGS.passi, P3] })).ok).toBe(true);
    const [row] = await db.select().from(pendingActionsTable);
    const pub = row!.argsPublic as { steps: Record<string, unknown>[] };
    const old = { ...pub, steps: pub.steps.map(({ refs: _refs, ...rest }) => rest) };
    await db.update(pendingActionsTable).set({ argsPublic: old }).where(eq(pendingActionsTable.id, row!.id));
    const [again] = await db.select().from(pendingActionsTable);
    const steps = (await loadProposalSteps([row!.id])).get(row!.id)!;
    expect(toProposalView(again!, steps, new Map())!.steps[1]!.refs).toEqual([{ param: "projectId", step: "p1", field: ["id"] }]);
    expect(await previewExclusion(userId, row!.number, ["p1"])).toEqual({ excluded: ["p1"], skipped: ["p2"] });
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
    expect(r).toEqual({ ok: false, content: "strumento create_project non disponibile per le proposte" });
  });
});
