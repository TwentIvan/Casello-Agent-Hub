import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, agentsTable, aiAccountsTable, aiModelsTable, appsTable, runStepsTable, runsTable, usersTable } from "@workspace/db";

// Valutazione del modello di un agente (issue #112) sull'app completa senza login (AUTH_DISABLED=true: utente
// dev@localhost). Account, modelli e run si inseriscono a mano nel DB; nessuno scheduler: le run restano come scritte.

let base: string;
let server: http.Server;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

async function account(userId: number, name: string) {
  const [a] = await db
    .insert(aiAccountsTable)
    .values({ userId, name, provider: "custom", baseUrl: "https://ai.example/v1", status: "ok" })
    .returning();
  return a!.id;
}

async function addModel(accountId: number, modelId: string, input: string | null, output: string | null, supportsTools: boolean | null = true) {
  const [m] = await db
    .insert(aiModelsTable)
    .values({ accountId, modelId, displayName: modelId, priceInputPerMtok: input, priceOutputPerMtok: output, supportsTools, availability: "available" })
    .returning();
  return m!.id;
}

beforeAll(async () => {
  for (const k of ["AUTH_DISABLED"]) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("GET /api/agents/:id/model-evaluation", () => {
  it("statistiche delle ultime run e modelli con strumenti più economici dell'utente", async () => {
    const userId = await devUserId();
    const mine = await account(userId, "Mio");
    const current = await addModel(mine, `caro-${Date.now()}`, "1", "2");
    const cheap = await addModel(mine, `economico-${Date.now()}`, "0.1", "0.2");
    const excluded = [
      await addModel(mine, `senza-tool-${Date.now()}`, "0.01", "0.01", false),
      await addModel(mine, `anteprima-preview-${Date.now()}`, "0.01", "0.01"),
      await addModel(mine, `senza-prezzo-${Date.now()}`, null, null),
    ];
    // Modello economico di un altro utente: non è un candidato
    const [other] = await db.insert(usersTable).values({ email: `altro-${Date.now()}@example.com`, name: "Altro" }).returning();
    excluded.push(await addModel(await account(other!.id, "Altrui"), `altrui-${Date.now()}`, "0.01", "0.01"));

    const slug = `eval-${Math.random().toString(36).slice(2, 8)}`;
    const [app] = await db.insert(appsTable).values({ name: slug, slug, baseUrl: "https://eval.example" }).returning();
    const [agent] = await db
      .insert(agentsTable)
      .values({ appId: app!.id, name: "Area", status: "active", aiModelId: current })
      .returning();
    for (let i = 0; i < 6; i++) {
      const [r] = await db
        .insert(runsTable)
        .values({
          agentId: agent!.id,
          aiModelId: current,
          status: i === 5 ? "failed" : "succeeded",
          input: "x",
          promptTokens: 10_000,
          completionTokens: 1_000,
          costUsd: "0.012",
        })
        .returning();
      await db.insert(runStepsTable).values([
        { runId: r!.id, position: 1, type: "model" },
        { runId: r!.id, position: 2, type: "tool", toolName: "t", ok: i !== 5 },
      ]);
    }
    // Run in corso e run più vecchie della finestra: non contano
    await db.insert(runsTable).values({ agentId: agent!.id, aiModelId: current, status: "running", input: "x" });
    await db.insert(runsTable).values({
      agentId: agent!.id,
      aiModelId: current,
      status: "succeeded",
      input: "x",
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const res = await api("GET", `/agents/${agent!.id}/model-evaluation`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      agentId: agent!.id,
      agentName: "Area",
      windowDays: 30,
      enoughData: true,
      currentModel: { aiModelId: current, estimatedCostPerRunUsd: 0.012 },
      usage: { runs: 6, succeeded: 5, failed: 1, successRate: 0.8333, toolCalls: 6, toolErrors: 1, runsInWindow: 6, avgCostUsd: 0.012 },
    });
    // Il DB è condiviso con altri file: dell'utente possono esserci altri modelli, si guardano solo quelli di questo test
    const ids = res.json.suggestions.map((s: { aiModelId: number }) => s.aiModelId);
    for (const id of [...excluded, current]) expect(ids).not.toContain(id);
    expect(res.json.suggestions.find((s: { aiModelId: number }) => s.aiModelId === cheap)).toMatchObject({
      savingPercent: 90,
      estimatedMonthlySavingUsd: 0.06,
    });
    expect(res.json.byModel).toEqual([expect.objectContaining({ aiModelId: current, runs: 6 })]);
  });

  it("agente inesistente → 404", async () => {
    const res = await api("GET", "/agents/999999999/model-evaluation");
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Agente non trovato" });
  });
});
