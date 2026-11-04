import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, appToolsTable, pendingActionsTable, teamTurnsTable, usersTable, type InsertAppTool } from "@workspace/db";
import { encryptSecret } from "../secrets";
import type { CatalogTool } from "../tools/types";
import { enqueueAction, enqueuePlanItem } from "../actions/queue";
import { approveAction, rejectAction } from "../actions/decide";
import type { InstanceRole } from "./manifest";
import { closeInstance, createInstance } from "./instances";
import { getPlan, setPlanStatus, writePlanVersion, type Plan } from "./plan";

// Piani e modifiche del piano nella coda delle conferme (PGlite del global setup, route sull'app completa)

const DEV_EMAIL = "dev@localhost";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let userId: number;
let appId: number;
let modelId: number;
let instanceId: number;

const plan = (objective = "Obiettivo"): Plan => ({ objective, constraints: [], openPoints: [], tasks: [], manualActions: [] });
const irole = (): InstanceRole => ({ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [], localSkills: [] });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Propone un PLAN (versione nuova `proposed`) e mette in coda la voce. */
async function propose(kind: "plan" | "plan_change" = "plan"): Promise<number> {
  const view = await writePlanVersion(instanceId, plan(`Obiettivo ${Date.now()}`), "proposed");
  const out = await enqueuePlanItem({ userId, instanceId, kind, planVersion: view.version, recipient: "S", summary: "Piano della squadra", detail: { objective: view.objective } });
  if (!out.ok) throw new Error(out.message);
  return out.number;
}

const turns = () => db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
const rowOf = async (n: number) => (await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n)))[0]!;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: DEV_EMAIL, CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances CASCADE");
  const [u] = await db.insert(usersTable).values({ email: DEV_EMAIL, name: "Dev" }).returning();
  userId = u!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "M1" }).returning();
  modelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  appId = app!.id;
  instanceId = (await createInstance(userId, { name: "Squadra", ref: { appId, type: "wi", id: "1" }, roles: [irole()] })).id;
});

describe("decisione sulle voci di piano", () => {
  it("approvare un piano: PLAN approvato, voce done, turno in coda con il motivo", async () => {
    const n = await propose();
    const out = await approveAction(userId, n, {});
    expect(out.ok && out.action.status).toBe("done");
    const p = await getPlan(instanceId);
    expect(p.status).toBe("approved");
    expect(p.approvedVersion).toBe(p.version);
    const t = await turns();
    expect(t).toHaveLength(1);
    expect(t[0]!.status).toBe("queued");
    expect(t[0]!.reasons).toEqual([{ type: "decision", number: n, outcome: "approved", note: null }]);
  });

  it("rifiutare con nota: PLAN torna a draft senza versione nuova, il turno porta la nota", async () => {
    const n = await propose();
    const before = await getPlan(instanceId);
    const out = await rejectAction(userId, n, "manca il vincolo sul budget");
    expect(out.ok && out.action.status).toBe("rejected");
    const p = await getPlan(instanceId);
    expect(p.status).toBe("draft");
    expect(p.version).toBe(before.version);
    expect((await turns())[0]!.reasons).toEqual([{ type: "decision", number: n, outcome: "rejected", note: "manca il vincolo sul budget" }]);
  });

  it("rifiutare una modifica: PLAN torna approvato con la versione approvata di prima", async () => {
    const first = await propose();
    await approveAction(userId, first, {});
    const approvedVersion = (await getPlan(instanceId)).approvedVersion;
    const n = await propose("plan_change");
    expect((await getPlan(instanceId)).status).toBe("proposed");
    await rejectAction(userId, n, null);
    const p = await getPlan(instanceId);
    expect(p.status).toBe("approved");
    expect(p.approvedVersion).toBe(approvedVersion);
  });

  it("versione superata: voce failed (HTTP 200), PLAN e turni invariati", async () => {
    const n = await propose();
    await writePlanVersion(instanceId, plan("Più recente"), "proposed");
    const res = await api("POST", `/pending-actions/${n}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("failed");
    expect(res.json.errorMessage).toBe("proposta superata da una versione più recente");
    expect((await getPlan(instanceId)).status).toBe("proposed");
    expect(await turns()).toHaveLength(0);
  });

  it("squadra chiusa: 409 «squadra chiusa», voce invariata, nessun turno", async () => {
    const n = await propose();
    await closeInstance(instanceId);
    const res = await api("POST", `/pending-actions/${n}/approve`, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("squadra chiusa");
    expect((await rowOf(n)).status).toBe("pending");
    expect(await turns()).toHaveLength(0);
    expect((await getPlan(instanceId)).status).toBe("proposed");
  });

  it("rifiutare in una squadra chiusa chiude la voce senza turno", async () => {
    const n = await propose();
    await closeInstance(instanceId);
    const res = await api("POST", `/pending-actions/${n}/reject`, { note: "no" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("rejected");
    expect(await turns()).toHaveLength(0);
  });

  it("una voce già decisa non si decide due volte", async () => {
    const n = await propose();
    await approveAction(userId, n, {});
    const again = await approveAction(userId, n, {});
    expect(again).toEqual({ ok: false, status: 409, message: "azione già decisa" });
    expect(await turns()).toHaveLength(1);
    expect((await turns())[0]!.reasons).toHaveLength(1);
  });
});

describe("coda unica", () => {
  it("numerazione unica tra azioni e piani; elenco con kind, team e azioni esistenti; contatore", async () => {
    const [row] = await db
      .insert(appToolsTable)
      .values({ appId, name: "set_password", kind: "mcp", identity: "service", level: "L2", status: "active", paramsSchema: { type: "object", properties: {} }, definition: { mcpName: "set_password" } } as InsertAppTool)
      .returning();
    const tool = { ...row!, paramsSchema: { type: "object", properties: {} }, definition: row!.definition as CatalogTool["definition"] } as CatalogTool;
    const a = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args: {}, recipient: "Rosa", summary: "Cambia la password" });
    const p = await propose();
    const a2 = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args: {}, recipient: "Rosa", summary: "Altra azione" });
    expect([a, a2].map((x) => x.ok && x.number)).toEqual([1, 3]);
    expect(p).toBe(2);

    const list = await api("GET", "/pending-actions?status=pending");
    expect(list.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byNumber = new Map<number, any>(list.json.actions.map((x: any) => [x.number, x]));
    expect(byNumber.get(2)).toMatchObject({ kind: "plan", team: { id: instanceId, name: "Squadra" }, app: null, tool: null, recipient: "S" });
    expect(byNumber.get(1)).toMatchObject({ kind: "action", team: null, app: { id: appId }, tool: { name: "set_password" } });
    const detail = await api("GET", `/pending-actions/${p}`);
    expect(detail.json.kind).toBe("plan");
    expect((await api("GET", "/dashboard/stats")).json.pendingActions).toBe(3);

    const rejected = await api("POST", `/pending-actions/1/reject`, {});
    expect(rejected.json.status).toBe("rejected");
    await setPlanStatus(instanceId, "proposed");
    expect((await api("POST", `/pending-actions/${p}/approve`, {})).json.status).toBe("done");
  });
});
