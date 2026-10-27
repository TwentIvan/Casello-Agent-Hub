import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  appsTable,
  localJobsTable,
  localMachinesTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { runRunner } from "../src/runner";

// Da capo a fondo: l'API vera (app Express completa, Postgres di prova) e il runner con il finto `claude`, che
// parla MCP con /api/mcp usando il token del lavoro. Una run e un'analisi arrivano a fine.

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

let server: http.Server;
let base: string;
let scratch: string;
let ac: AbortController;
let running: Promise<void> | null;
let logs: string[];
const savedEnv = { ...process.env };

// Moduli dell'API importati dopo aver impostato l'ambiente
let registerMachine: typeof import("../../api-server/src/lib/local/machines").registerMachine;
let machineModelId: typeof import("../../api-server/src/lib/local/machines").machineModelId;
let startRun: typeof import("../../api-server/src/lib/run-executor").startRun;
let startAnalysis: typeof import("../../api-server/src/lib/architect/run-analysis").startAnalysis;
let failOpenLocalJobs: typeof import("../../api-server/src/lib/local/jobs").failOpenLocalJobs;

beforeAll(async () => {
  process.env["AUTH_DISABLED"] = "true";
  process.env["LOG_LEVEL"] = "silent";
  process.env["CASELLO_SECRET_KEY"] = "d".repeat(64);
  delete process.env["PUBLIC_APP_URL"];
  const registry = await import("../../api-server/src/lib/catalog/provider-registry");
  await registry.ensureProviderRegistry();
  ({ registerMachine, machineModelId } = await import("../../api-server/src/lib/local/machines"));
  ({ startRun } = await import("../../api-server/src/lib/run-executor"));
  ({ startAnalysis } = await import("../../api-server/src/lib/architect/run-analysis"));
  ({ failOpenLocalJobs } = await import("../../api-server/src/lib/local/jobs"));
  const { default: app } = await import("../../api-server/src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  process.env = { ...savedEnv };
});

let userId: number;
let machineToken: string;
let machineId: number;
let localModelId: number;
let fallbackModelId: number;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  scratch = mkdtempSync(join(tmpdir(), "runner-e2e-"));
  logs = [];
  running = null;
  ac = new AbortController();
  process.env["FAKE_CLAUDE_MODE"] = "mcp";
  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = user!.id;
  const registered = await registerMachine(userId, "MacBook");
  machineId = registered.machine.id;
  machineToken = registered.token;
  const [local] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.modelId, machineModelId(machineId)));
  localModelId = local!.id;
  // Modello di riserva (mai chiamato: il runner è collegato)
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Riserva", provider: "custom", baseUrl: "https://api.example.com/v1", status: "ok" })
    .returning();
  const [fallback] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "riserva", displayName: "R" }).returning();
  fallbackModelId = fallback!.id;
});

afterEach(async () => {
  ac.abort();
  await running;
  await failOpenLocalJobs();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

async function startRunner(): Promise<void> {
  running = runRunner({
    url: base,
    token: machineToken,
    bin: FAKE_CLAUDE,
    signal: ac.signal,
    log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  });
  // Collegato: primo segnale di vita della macchina
  for (let i = 0; i < 500; i++) {
    const [m] = await db.select({ lastSeenAt: localMachinesTable.lastSeenAt }).from(localMachinesTable).where(eq(localMachinesTable.id, machineId));
    if (m?.lastSeenAt) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("runner non collegato");
}

/**
 * Lavoro completato e runner fermato dopo la fine dell'ultimo compito: l'arresto attende il done in corso, quindi
 * da lì ogni compito è stato riportato a Casello. Casello ha accettato ogni done (nessun log di done non riportato).
 */
async function finishJob(where: ReturnType<typeof eq>, items: number): Promise<typeof localJobsTable.$inferSelect> {
  for (let i = 0; i < 1000 && logs.filter((l) => l.startsWith("compito terminato")).length < items; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  ac.abort();
  await running;
  const [job] = await db.select().from(localJobsTable).where(where);
  expect(logs.filter((l) => l.startsWith("compito terminato") && l.includes('"esito":"done"'))).toHaveLength(items);
  expect(logs.some((l) => l.startsWith("fine del compito") || l.startsWith("compito già chiuso"))).toBe(false);
  return job!;
}

async function createApp(over: Partial<typeof appsTable.$inferInsert> = {}): Promise<number> {
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: `mister-${Math.random().toString(36).slice(2, 8)}`, baseUrl: "https://mister.example", ...over })
    .returning();
  return app!.id;
}

describe("runner con l'API vera", () => {
  it("una run dell'agente locale arriva a fine: finish_run via MCP, done con la sessione di Claude", async () => {
    const appId = await createApp();
    const [agent] = await db
      .insert(agentsTable)
      .values({
        appId,
        name: "Generale",
        role: "general",
        status: "active",
        model: machineModelId(machineId),
        aiModelId: localModelId,
        fallbackAiModelId: fallbackModelId,
        systemPrompt: "Aiuta l'allenatore.",
      })
      .returning();
    const [run] = await db.insert(runsTable).values({ agentId: agent!.id, input: "Fai il lavoro" }).returning();

    await startRunner();
    await startRun(run!.id, { startedBy: userId });

    const [after] = await db.select().from(runsTable).where(eq(runsTable.id, run!.id));
    expect(after!.errorMessage).toBeNull();
    expect(after!.status).toBe("succeeded");
    expect(after!.output).toBe("fatto dal finto Claude");
    const job = await finishJob(eq(localJobsTable.runId, run!.id), 1);
    expect(job).toMatchObject({ status: "completed", claimedBy: "runner" });
    expect(logs.join("\n")).not.toContain(machineToken);
    expect(logs.join("\n")).not.toContain("csl_j_");
  });

  it("un'analisi dell'architetto con l'agente locale arriva a fine: sei fasi consegnate via MCP", async () => {
    const { PHASE_EXAMPLES } = await import("../../api-server/src/lib/architect/prompts");
    const plan = join(scratch, "plan.json");
    writeFileSync(plan, JSON.stringify({ results: PHASE_EXAMPLES }));
    process.env["FAKE_CLAUDE_PLAN"] = plan;
    const appId = await createApp({ functionalDescription: "Gestione di squadre di fantacalcio" });
    const [analysis] = await db
      .insert(analysesTable)
      .values({
        appId,
        model: machineModelId(machineId),
        aiModelId: localModelId,
        fallbackAiModelId: fallbackModelId,
        sources: { code: "none", openapi: false, description: true },
        maxTokens: 1_000_000,
      })
      .returning();

    await startRunner();
    await startAnalysis(analysis!.id);

    const [after] = await db.select().from(analysesTable).where(eq(analysesTable.id, analysis!.id));
    expect(after!.error).toBeNull();
    expect(after!.status).toBe("completed");
    const job = await finishJob(eq(localJobsTable.analysisId, analysis!.id), 6);
    expect(job).toMatchObject({ status: "completed", kind: "analysis", claimedBy: "runner" });
  });
});
