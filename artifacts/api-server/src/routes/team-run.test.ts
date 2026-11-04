import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  teamEventsTable,
  teamTaskStepsTable,
  teamTasksTable,
  teamTurnStepsTable,
  teamTurnsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Route dell'esecuzione delle squadre sull'app completa senza login (AUTH_DISABLED=true). L'avvio dei turni non è
// collegato (lo fa src/index.ts): i turni restano in coda e nessun modello viene chiamato.

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let userId: number;
let instanceId: number;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  expect((await api("GET", "/auth/me")).status).toBe(200);
  const [u] = await db.select().from(usersTable);
  userId = u!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "M1" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  const created = await api("POST", "/team-instances", {
    name: "S",
    ref: { appId: app!.id, type: "wi", id: "1" },
    roles: [{ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: model!.id, tools: [], skills: [], localSkills: [] }],
  });
  expect(created.status, created.text).toBe(201);
  instanceId = created.json.id;
});

describe("route dell'esecuzione delle squadre", () => {
  it("attivazione: active, activatedBy, PLAN draft e turno activation; seconda attivazione 409", async () => {
    const res = await api("POST", `/team-instances/${instanceId}/activate`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ status: "active", activatedBy: userId, monthlyBudgetUsd: null, lastTurnAt: null });
    expect((await api("GET", `/team-instances/${instanceId}/plan`)).json).toMatchObject({ version: 1, status: "draft" });
    const turns = await api("GET", `/team-instances/${instanceId}/turns`);
    expect(turns.json).toMatchObject([{ status: "queued", reasons: [{ type: "activation" }], steps: [] }]);
    expect((await api("POST", `/team-instances/${instanceId}/activate`)).status).toBe(409);
    expect((await api("POST", `/team-instances/999/activate`)).status).toBe(404);
  });

  it("messaggi al capo: solo a squadra attiva, si accodano allo stesso turno; l'11ª richiesta nel minuto → 429", async () => {
    expect((await api("POST", `/team-instances/${instanceId}/messages`, { text: "ciao" })).status).toBe(409);
    await api("POST", `/team-instances/${instanceId}/activate`);
    expect((await api("POST", `/team-instances/${instanceId}/messages`, { text: "   " })).status).toBe(400);
    expect((await api("POST", `/team-instances/${instanceId}/messages`, { text: "x".repeat(4001) })).status).toBe(400);
    const ok = await api("POST", `/team-instances/${instanceId}/messages`, { text: "prima richiesta" });
    expect(ok.status, ok.text).toBe(202);
    expect(ok.json).toEqual({ queued: true });
    for (let i = 5; i <= 10; i++) expect((await api("POST", `/team-instances/${instanceId}/messages`, { text: `richiesta ${i}` })).status).toBe(202);
    expect((await api("POST", `/team-instances/${instanceId}/messages`, { text: "undicesima" })).status).toBe(429);

    const turns = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.reasons[0]).toEqual({ type: "activation" });
    expect(turns[0]!.reasons[1]).toEqual({ type: "request", text: "prima richiesta" });
  });

  it("tetto della squadra: PUT salva e azzera; negativo → 400; squadra chiusa → 409", async () => {
    const set = await api("PUT", `/team-instances/${instanceId}/budget`, { monthlyBudgetUsd: 12.5 });
    expect(set.status, set.text).toBe(200);
    expect(set.json.monthlyBudgetUsd).toBe(12.5);
    expect((await api("GET", `/team-instances/${instanceId}`)).json.monthlyBudgetUsd).toBe(12.5);
    expect((await api("PUT", `/team-instances/${instanceId}/budget`, { monthlyBudgetUsd: null })).json.monthlyBudgetUsd).toBeNull();
    expect((await api("PUT", `/team-instances/${instanceId}/budget`, { monthlyBudgetUsd: -1 })).status).toBe(400);
    await api("POST", `/team-instances/${instanceId}/close`);
    expect((await api("PUT", `/team-instances/${instanceId}/budget`, { monthlyBudgetUsd: 1 })).status).toBe(409);
  });

  it("compiti con i passi, turni con i passi, eventi e bollettino dell'utente", async () => {
    await api("POST", `/team-instances/${instanceId}/activate`);
    const [task] = await db
      .insert(teamTasksTable)
      .values({ instanceId, planTaskId: "t1", roleKey: "capo", instructions: "fai", status: "done", outcome: "fatto", costUsd: "0.020000" })
      .returning();
    await db.insert(teamTaskStepsTable).values({ taskId: task!.id, position: 0, type: "model", ok: true });
    const [turn] = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
    await db.insert(teamTurnStepsTable).values({ turnId: turn!.id, position: 0, type: "tool", toolName: "leggi_piano", args: {}, ok: true });
    const [e1] = await db.insert(teamEventsTable).values({ instanceId, type: "compito_finito", taskId: task!.id, bulletin: "Compito t1 fatto" }).returning();
    await db.insert(teamEventsTable).values({ instanceId, type: "bloccato", bulletin: "Bloccato" });

    const tasks = await api("GET", `/team-instances/${instanceId}/tasks`);
    expect(tasks.status, tasks.text).toBe(200);
    expect(tasks.json).toMatchObject([{ id: task!.id, planTaskId: "t1", status: "done", costUsd: 0.02 }]);
    expect(tasks.json[0].steps).toBeUndefined();
    const detail = await api("GET", `/team-instances/${instanceId}/tasks/${task!.id}`);
    expect(detail.json.steps).toMatchObject([{ position: 0, type: "model", ok: true }]);
    expect((await api("GET", `/team-instances/${instanceId}/tasks/9999`)).status).toBe(404);
    expect((await api("GET", `/team-instances/${instanceId}/turns`)).json[0].steps).toMatchObject([{ toolName: "leggi_piano" }]);
    expect((await api("GET", `/team-instances/${instanceId}/events`)).json.map((e: { type: string }) => e.type)).toEqual(["bloccato", "compito_finito"]);

    expect((await api("GET", "/team-events?unread=true")).json).toHaveLength(2);
    const read = await api("POST", "/team-events/read", { ids: [e1!.id] });
    expect(read.json).toEqual({ updated: 1 });
    expect((await api("GET", "/team-events?unread=true")).json.map((e: { bulletin: string }) => e.bulletin)).toEqual(["Bloccato"]);
    expect((await api("GET", "/team-events?unread=false")).json).toHaveLength(2);
    expect((await api("GET", "/team-events")).json).toHaveLength(2);
    expect((await api("GET", "/team-events?unread=forse")).status).toBe(400);
  });
});
