import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentTriggersTable,
  agentsTable,
  appsTable,
  auditEventsTable,
  db,
  fleetPolicyTable,
  pool,
  runsTable,
  usersTable,
} from "@workspace/db";

// Flotta degli agenti su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true: utente di sviluppo).

const realFetch = globalThis.fetch;
const TOKEN_EMAIL = "flotta@example.com";
let base: string;
let server: http.Server;
const saved: Record<string, string | undefined> = {};
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await realFetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ["AUTH_DISABLED", "ALLOWED_EMAILS"]) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = `${TOKEN_EMAIL},dev@localhost`;
  const { requireAuth } = await import("../lib/auth");
  const { createFleetRouter } = await import("./fleet");
  const { auditRoutes } = await import("../lib/audit/record");
  const { errorHandler } = await import("../middlewares/error-handler");
  ({ createApiToken } = await import("../lib/api-tokens"));
  const mini = express();
  mini.use(express.json());
  mini.use("/api", requireAuth, auditRoutes(), createFleetRouter());
  mini.use("/api", errorHandler);
  server = http.createServer(mini);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("TRUNCATE apps, users, fleet_policy RESTART IDENTITY CASCADE");
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps, users, fleet_policy RESTART IDENTITY CASCADE");
});

async function seed() {
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" }).returning();
  const values = (name: string, status: "active" | "inactive") => ({ appId: app!.id, name, role: "area" as const, status });
  const [sano, rotto, spento, innesco] = await db
    .insert(agentsTable)
    .values([values("Sano", "active"), values("Rotto", "active"), values("Spento", "inactive"), values("Innesco", "active")])
    .returning();
  const now = new Date();
  const run = (agentId: number, status: "succeeded" | "failed" | "cancelled" | "pending", error: string | null = null, costUsd: string | null = null) => ({
    agentId,
    status,
    errorMessage: error,
    costUsd,
    durationMs: status === "pending" ? null : 1000,
    finishedAt: status === "pending" ? null : now,
  });
  await db.insert(runsTable).values([
    run(sano!.id, "succeeded", null, "0.010000"),
    run(sano!.id, "succeeded", null, "0.020000"),
    run(sano!.id, "pending"),
    run(rotto!.id, "failed", "primo errore"),
    run(rotto!.id, "failed", "  tool\n  non raggiungibile  "),
    run(rotto!.id, "succeeded"),
    // Fuori dalla finestra delle 24 ore
    { ...run(rotto!.id, "failed", "vecchio"), finishedAt: new Date(now.getTime() - 48 * 3_600_000) },
  ]);
  await db.insert(agentTriggersTable).values({ agentId: innesco!.id, kind: "webhook", name: "hook", secretHash: "h", status: "error" });
  return { sano: sano!, rotto: rotto!, spento: spento!, innesco: innesco! };
}

describe("flotta degli agenti", () => {
  it("GET /fleet: salute, numeri delle 24 ore, riepilogo e politica predefinita", async () => {
    const { sano, rotto, spento, innesco } = await seed();
    const res = await api("GET", "/fleet");
    expect(res.status, res.text).toBe(200);
    const byId = new Map(res.json.agents.map((a: { agentId: number }) => [a.agentId, a]));
    // Dal più grave: falliscono (gli agenti attivi qui non hanno modello), per nome, poi spenti
    expect(res.json.agents.map((a: { name: string }) => a.name)).toEqual(["Innesco", "Rotto", "Sano", "Spento"]);
    expect(byId.get(rotto.id)).toMatchObject({
      health: "failing",
      issues: ["no_model", "high_failure"],
      failed24h: 2,
      succeeded24h: 1,
      successRate: 1 / 3,
      lastError: "tool non raggiungibile",
      cost24hUsd: null,
    });
    expect(byId.get(innesco.id)).toMatchObject({ health: "failing", triggersInError: 1 });
    expect(byId.get(spento.id)).toMatchObject({ health: "off", issues: [] });
    expect(byId.get(sano.id)).toMatchObject({ health: "failing", issues: ["no_model"], succeeded24h: 2, pendingRuns: 1, cost24hUsd: 0.03, avgDurationMs: 1000, activity: "working" });
    expect(res.json.summary).toMatchObject({ agents: 4, failing: 3, off: 1, pendingRuns: 1, succeeded24h: 3, failed24h: 2, cost24hUsd: 0.03 });
    expect(res.json.policy).toMatchObject({ paused: false, maxRunningRuns: 6, maxRunningPerAgent: 2, updatedAt: null });
  });

  it("PUT /fleet/policy salva i limiti e lascia un evento nel registro", async () => {
    const bad = await api("PUT", "/fleet/policy", { maxRunningRuns: 3, maxRunningPerAgent: 4 });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("limiti della flotta non validi");
    const ok = await api("PUT", "/fleet/policy", { maxRunningRuns: 10, maxRunningPerAgent: 3 });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toMatchObject({ maxRunningRuns: 10, maxRunningPerAgent: 3, paused: false });
    expect((await api("GET", "/fleet")).json.policy.maxRunningRuns).toBe(10);
    for (let i = 0; i < 50 && (await db.select().from(auditEventsTable)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const [event] = await db.select().from(auditEventsTable);
    expect(event).toMatchObject({ action: "fleet.policy.update", detail: { maxRunningRuns: 10, maxRunningPerAgent: 3 } });
  });

  it("pausa e ripresa: 409 se già nello stato, motivo controllato e nome di chi ha messo in pausa", async () => {
    expect((await api("POST", "/fleet/pause", { reason: "riga\nsbagliata" })).status).toBe(400);
    const paused = await api("POST", "/fleet/pause", { reason: "manutenzione del provider" });
    expect(paused.status, paused.text).toBe(200);
    expect(paused.json).toMatchObject({ paused: true, pauseReason: "manutenzione del provider" });
    expect(paused.json.pausedByName).toBeTruthy();
    expect((await api("POST", "/fleet/pause", {})).status).toBe(409);
    const resumed = await api("POST", "/fleet/resume");
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ paused: false, pausedAt: null, pauseReason: null });
    const again = await api("POST", "/fleet/resume");
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("la flotta non è in pausa");
  });

  it("con un token personale si legge ma non si governa", async () => {
    const [user] = await db.insert(usersTable).values({ email: TOKEN_EMAIL }).returning();
    const { token } = await createApiToken(user!.id, "Script", 30, ["api:write"]);
    expect((await api("GET", "/fleet", undefined, token)).status).toBe(200);
    expect((await api("POST", "/fleet/pause", {}, token)).status).toBe(403);
    expect((await api("PUT", "/fleet/policy", { maxRunningRuns: 6, maxRunningPerAgent: 2 }, token)).status).toBe(403);
    expect(await db.select().from(fleetPolicyTable)).toHaveLength(0);
  });
});
