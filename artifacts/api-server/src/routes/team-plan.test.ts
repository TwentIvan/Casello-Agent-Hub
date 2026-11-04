import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, teamTurnsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Route del PLAN delle squadre sull'app completa senza login (AUTH_DISABLED=true)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let modelId: number;
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

const task = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Compito ${id}`, roleKey: "capo", instructions: "fai", status: "planned", outcome: null, ...over });
const plan = (over: Record<string, unknown> = {}) => ({ objective: "Obiettivo", constraints: [], openPoints: [], tasks: [task("t1")], manualActions: [], ...over });

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
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: u!.id, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "M1" }).returning();
  modelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  const created = await api("POST", "/team-instances", {
    name: "S",
    ref: { appId: app!.id, type: "wi", id: "1" },
    roles: [{ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [], localSkills: [] }],
  });
  expect(created.status, created.text).toBe(201);
  instanceId = created.json.id;
});

describe("route del PLAN", () => {
  it("GET crea il draft vuoto; PUT salva la v2 approvata e accoda un turno; GET la rilegge", async () => {
    expect((await api("GET", `/team-instances/${instanceId}/plan`)).json).toMatchObject({ version: 1, status: "draft", tasks: [] });
    const put = await api("PUT", `/team-instances/${instanceId}/plan`, plan());
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({ version: 2, status: "approved", approvedVersion: 2, objective: "Obiettivo" });
    expect(put.json.tasks[0].updatedAt).toBeTruthy();
    expect((await api("GET", `/team-instances/${instanceId}/plan`)).json.version).toBe(2);
    expect(await db.select().from(teamTurnsTable)).toHaveLength(1);
  });

  it("errori: ruolo inesistente 400, 51 compiti 400, istanza inesistente 404, squadra chiusa 409", async () => {
    const bad = await api("PUT", `/team-instances/${instanceId}/plan`, plan({ tasks: [task("t1", { roleKey: "boh" })] }));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("ruolo boh inesistente");
    const many = await api("PUT", `/team-instances/${instanceId}/plan`, plan({ tasks: Array.from({ length: 51 }, (_, i) => task(`t${i + 1}`)) }));
    expect(many.status).toBe(400);
    expect((await api("GET", "/team-instances/9999/plan")).status).toBe(404);
    await api("POST", `/team-instances/${instanceId}/close`);
    const closed = await api("PUT", `/team-instances/${instanceId}/plan`, plan());
    expect(closed.status).toBe(409);
    expect(closed.json.error).toBe("squadra chiusa");
    expect((await api("POST", `/team-instances/${instanceId}/plan/manual-actions/a1/done`)).status).toBe(409);
  });

  it("azione manuale «Fatto»: done e doneAt", async () => {
    await api("PUT", `/team-instances/${instanceId}/plan`, plan({ manualActions: [{ id: "a1", text: "Esegui", done: false, doneAt: null }] }));
    const done = await api("POST", `/team-instances/${instanceId}/plan/manual-actions/a1/done`);
    expect(done.status, done.text).toBe(200);
    expect(done.json.manualActions[0]).toMatchObject({ id: "a1", done: true });
    expect(done.json.manualActions[0].doneAt).toBeTruthy();
    expect(done.json.version).toBe(2);
    expect((await api("POST", `/team-instances/${instanceId}/plan/manual-actions/zz/done`)).status).toBe(404);
  });
});
