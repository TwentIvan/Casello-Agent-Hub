import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, pendingActionsTable, teamPlanVersionsTable, teamTurnsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { InstanceRole } from "./manifest";
import { closeInstance, createInstance, InstanceError } from "./instances";
import { TeamRuleError } from "./rules";
import { correctPlan, diffSummary, getPlan, isRelevantChange, markManualActionDone, nextTaskIds, patchPlan, PlanSchema, setPlanStatus, writePlanVersion, type Plan } from "./plan";
import { enqueueTurnReason, setOnTurnQueued } from "./turn-queue";

// PLAN versionato e coda dei turni sul Postgres di prova (PGlite del global setup)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);

let userId: number;
let appId: number;
let modelId: number;
let instanceId: number;

const task = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Compito ${id}`,
  roleKey: "capo",
  instructions: "fai",
  status: "planned" as const,
  outcome: null,
  ...over,
});
const plan = (over: Partial<Plan> = {}): Plan => ({
  objective: "Obiettivo",
  constraints: ["niente rete"],
  openPoints: [],
  tasks: [task("t1")],
  manualActions: [],
  ...over,
});
const irole = (): InstanceRole => ({ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], code: "none", skills: [], localSkills: [] });

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "me@example.com", name: "Io" }).returning();
  userId = u!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "M1" }).returning();
  modelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  appId = app!.id;
  instanceId = (await createInstance(userId, { name: "S", ref: { appId, type: "wi", id: "1" }, roles: [irole()] })).id;
});

afterAll(async () => {
  setOnTurnQueued(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
});

describe("funzioni pure del PLAN", () => {
  const base = plan({ tasks: [task("t1"), task("t2")] });
  it("cambiare issue di un compito è una modifica rilevante", () => {
    const plain = plan();
    const withIssue = plan({ tasks: [task("t1", { issue: 12 })] });
    expect(PlanSchema.safeParse(withIssue).success).toBe(true);
    expect(isRelevantChange(plain, withIssue)).toBe(true);
    expect(isRelevantChange(withIssue, plan({ tasks: [task("t1", { issue: 12 })] }))).toBe(false);
    expect(isRelevantChange(plan({ tasks: [task("t1", { issue: null })] }), plain)).toBe(false);
  });

  it("isRelevantChange: rilevanti obiettivo, vincoli, compiti aggiunti/tolti e titolo/ruolo/istruzioni", () => {
    expect(isRelevantChange(null, base)).toBe(true);
    expect(isRelevantChange(base, { ...base, objective: "Altro" })).toBe(true);
    expect(isRelevantChange(base, { ...base, constraints: [] })).toBe(true);
    expect(isRelevantChange(base, { ...base, tasks: [...base.tasks, task("t3")] })).toBe(true);
    expect(isRelevantChange(base, { ...base, tasks: [base.tasks[0]!] })).toBe(true);
    expect(isRelevantChange(base, { ...base, tasks: [task("t1", { title: "X" }), base.tasks[1]!] })).toBe(true);
    expect(isRelevantChange(base, { ...base, tasks: [task("t1", { roleKey: "altro" }), base.tasks[1]!] })).toBe(true);
    expect(isRelevantChange(base, { ...base, tasks: [task("t1", { instructions: "x" }), base.tasks[1]!] })).toBe(true);
  });
  it("isRelevantChange: non rilevanti punti aperti, azioni manuali, stato ed esito", () => {
    expect(isRelevantChange(base, { ...base, openPoints: ["?"] })).toBe(false);
    expect(isRelevantChange(base, { ...base, manualActions: [{ id: "a1", text: "x", done: false, doneAt: null }] })).toBe(false);
    expect(isRelevantChange(base, { ...base, tasks: [task("t1", { status: "done", outcome: "ok" }), base.tasks[1]!] })).toBe(false);
  });
  it("diffSummary: compito aggiunto e obiettivo cambiato", () => {
    const after = { ...base, objective: "Altro", tasks: [...base.tasks, task("t4", { title: "Verifica SCC1" })] };
    expect(diffSummary(base, after)).toBe("compiti aggiunti: t4 Verifica SCC1; obiettivo cambiato");
    expect(diffSummary(base, base)).toBe("nessuna modifica rilevante");
  });
  it("nextTaskIds parte da t<max+1>", () => {
    expect(nextTaskIds(plan({ tasks: [task("t2"), task("t7")] }), 2)).toEqual(["t8", "t9"]);
    expect(nextTaskIds(plan({ tasks: [] }), 1)).toEqual(["t1"]);
  });
  it("limiti: 51 compiti non passano lo schema", () => {
    expect(PlanSchema.safeParse(plan({ tasks: Array.from({ length: 51 }, (_, i) => task(`t${i + 1}`)) })).success).toBe(false);
    expect(PlanSchema.safeParse(plan({ tasks: Array.from({ length: 50 }, (_, i) => task(`t${i + 1}`)) })).success).toBe(true);
  });
});

describe("PLAN salvato", () => {
  it("getPlan crea un draft vuoto alla versione 1", async () => {
    expect(await getPlan(instanceId)).toMatchObject({ version: 1, status: "draft", objective: "", tasks: [], approvedVersion: null });
  });

  it("writePlanVersion incrementa la versione e conserva le versioni; approved fissa approvedVersion", async () => {
    const v2 = await writePlanVersion(instanceId, plan(), "proposed");
    expect(v2).toMatchObject({ version: 2, status: "proposed", approvedVersion: null });
    expect(v2.tasks[0]!.updatedAt).toBeTruthy();
    const v3 = await writePlanVersion(instanceId, plan({ objective: "Nuovo" }), "approved");
    expect(v3).toMatchObject({ version: 3, status: "approved", approvedVersion: 3 });
    const versions = await db.select().from(teamPlanVersionsTable).where(eq(teamPlanVersionsTable.instanceId, instanceId));
    expect(versions.map((v) => v.version).sort()).toEqual([2, 3]);
  });

  it("patchPlan aggiorna sul posto: nessuna versione né stato nuovi", async () => {
    await writePlanVersion(instanceId, plan({ tasks: [task("t1"), task("t2")] }), "approved");
    const patched = await patchPlan(instanceId, {
      tasks: [{ id: "t1", status: "done", outcome: "fatto" }, { id: "t9", status: "failed" }],
      openPoints: ["da chiarire"],
      manualActions: [{ id: "a1", text: "Esegui", done: false, doneAt: null }],
    });
    expect(patched).toMatchObject({ version: 2, status: "approved", approvedVersion: 2, openPoints: ["da chiarire"] });
    expect(patched.tasks.map((t) => [t.id, t.status, t.outcome])).toEqual([["t1", "done", "fatto"], ["t2", "planned", null]]);
    expect(await db.select().from(teamPlanVersionsTable)).toHaveLength(1);
  });

  it("setPlanStatus cambia solo stato e versione approvata", async () => {
    await writePlanVersion(instanceId, plan(), "proposed");
    const after = await setPlanStatus(instanceId, "approved", 2);
    expect(after).toMatchObject({ version: 2, status: "approved", approvedVersion: 2 });
    expect(await db.select().from(teamPlanVersionsTable)).toHaveLength(1);
  });

  it("correctPlan: v nuova approvata, rifiuta le voci plan aperte, accoda un turno request", async () => {
    await writePlanVersion(instanceId, plan(), "proposed");
    const item = (kind: "plan" | "plan_change" | "action", status: "pending" | "done", n: number) =>
      db
        .insert(pendingActionsTable)
        .values({ userId, number: n, kind, teamInstanceId: instanceId, planVersion: 2, argsEnc: "x", argsPublic: {}, recipient: "r", summary: "s", status, appId: null, toolId: null })
        .returning();
    await item("plan", "pending", 1);
    await item("plan_change", "pending", 2);
    await item("plan", "done", 3);
    const queued: number[] = [];
    setOnTurnQueued((id) => queued.push(id));

    const view = await correctPlan(instanceId, plan({ objective: "Corretto", tasks: [task("t1"), task("t2", { title: "Verifica SCC1" })] }));
    expect(view).toMatchObject({ version: 3, status: "approved", approvedVersion: 3, objective: "Corretto" });

    const rows = await db.select().from(pendingActionsTable).orderBy(pendingActionsTable.number);
    expect(rows.map((r) => r.status)).toEqual(["rejected", "rejected", "done"]);
    expect(rows[0]).toMatchObject({ decisionNote: "superata dalla modifica dell'utente" });
    expect(rows[0]!.decidedAt).not.toBeNull();
    expect(rows[2]!.decisionNote).toBeNull();

    const turns = await db.select().from(teamTurnsTable);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: "queued" });
    expect(turns[0]!.reasons).toEqual([{ type: "request", text: "Il piano è stato modificato dall'utente: compiti aggiunti: t2 Verifica SCC1; obiettivo cambiato" }]);
    expect(queued).toEqual([instanceId]);
  });

  it("correctPlan: i compiti invariati conservano updatedAt; stato ed esito dei compiti esistenti non si sovrascrivono", async () => {
    await writePlanVersion(instanceId, plan({ tasks: [task("t1"), task("t2")] }), "approved");
    await patchPlan(instanceId, { tasks: [{ id: "t2", status: "running", outcome: "in corso" }] });
    const before = await getPlan(instanceId);
    await new Promise((r) => setTimeout(r, 20));
    const view = await correctPlan(instanceId, plan({ tasks: [task("t1"), task("t2", { title: "Nuovo titolo", status: "planned", outcome: null }), task("t3", { status: "done", outcome: "x" })] }));
    const [t1, t2, t3] = view.tasks;
    expect(t1!.updatedAt).toBe(before.tasks[0]!.updatedAt);
    expect(t2!.updatedAt).not.toBe(before.tasks[1]!.updatedAt);
    expect(t2).toMatchObject({ title: "Nuovo titolo", status: "running", outcome: "in corso" });
    expect(t3).toMatchObject({ status: "planned", outcome: null });
  });

  it("correctPlan: ruolo inesistente → TeamRuleError, compito ripetuto, squadra chiusa → 409", async () => {
    await expect(correctPlan(instanceId, plan({ tasks: [task("t1", { roleKey: "boh" })] }))).rejects.toThrow("ruolo boh inesistente");
    await expect(correctPlan(instanceId, plan({ tasks: [task("t1"), task("t1")] }))).rejects.toBeInstanceOf(TeamRuleError);
    expect(await db.select().from(teamPlanVersionsTable)).toHaveLength(0);
    await closeInstance(instanceId);
    await expect(correctPlan(instanceId, plan())).rejects.toMatchObject({ status: 409, message: "squadra chiusa" });
    await expect(markManualActionDone(instanceId, "a1")).rejects.toBeInstanceOf(InstanceError);
  });

  it("azione manuale: «Fatto» imposta done e doneAt, senza versione nuova; id inesistente 404", async () => {
    await writePlanVersion(instanceId, plan({ manualActions: [{ id: "a1", text: "Esegui", done: false, doneAt: null }] }), "approved");
    const view = await markManualActionDone(instanceId, "a1");
    expect(view.version).toBe(2);
    expect(view.manualActions[0]).toMatchObject({ done: true });
    expect(view.manualActions[0]!.doneAt).toBeTruthy();
    await expect(markManualActionDone(instanceId, "zz")).rejects.toMatchObject({ status: 404 });
  });
});

describe("coda dei turni", () => {
  it("due motivi → una sola riga queued con due motivi; dopo l'avvio ne nasce un'altra", async () => {
    await enqueueTurnReason(instanceId, { type: "activation" });
    await enqueueTurnReason(instanceId, { type: "task_finished", taskId: 5 });
    let rows = await db.select().from(teamTurnsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reasons).toEqual([{ type: "activation" }, { type: "task_finished", taskId: 5 }]);
    await db.update(teamTurnsTable).set({ status: "running" });
    await enqueueTurnReason(instanceId, { type: "restart" });
    rows = await db.select().from(teamTurnsTable).orderBy(teamTurnsTable.id);
    expect(rows.map((r) => r.status)).toEqual(["running", "queued"]);
  });
});
