import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  agentTriggersTable,
  runsTable,
  usersTable,
  type AgentTrigger,
} from "@workspace/db";
import { fireSchedule } from "./schedule";
import { createTrigger, resumeTrigger, updateTrigger } from "./service";
import { TRIGGER_MESSAGES } from "./messages";
import { encryptSecret } from "../secrets";

// Tetto di spesa: di norma quello vero; un test lo sostituisce.
const budgetHook = vi.hoisted(() => ({ fn: null as null | (() => Promise<string | null>) }));
vi.mock("../budget", async () => {
  const actual = await vi.importActual<typeof import("../budget")>("../budget");
  return {
    ...actual,
    runBudgetBlock: (...args: Parameters<typeof actual.runBudgetBlock>) =>
      budgetHook.fn ? budgetHook.fn() : actual.runBudgetBlock(...args),
  };
});

// Run programmate (issue #107): la scadenza mette in coda una run come POST /agents/:id/runs. Lo scheduler delle run
// non gira qui: le run restano `pending`.

const savedKey = process.env["CASELLO_SECRET_KEY"];

beforeEach(async () => {
  budgetHook.fn = null;
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
});

async function seed(opts: { agent?: Partial<typeof agentsTable.$inferInsert>; trigger?: Partial<typeof agentTriggersTable.$inferInsert> } = {}) {
  const [owner] = await db.insert(usersTable).values({ email: "programmate@example.com", name: "Ivan" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: owner!.id,
      name: "Account",
      provider: "custom",
      baseUrl: "http://127.0.0.1:9/v1",
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" }).returning();
  const [agent] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Reporter", role: "area", status: "active", model: "m", aiModelId: model!.id, ...opts.agent })
    .returning();
  const [trigger] = await db
    .insert(agentTriggersTable)
    .values({
      agentId: agent!.id,
      kind: "schedule",
      name: "Report mattutino",
      status: "active",
      instructions: "Prepara il report delle email",
      cron: "0 8 * * *",
      intervalSeconds: null,
      nextPollAt: new Date("2026-11-24T07:00:00Z"),
      createdBy: owner!.id,
      ...opts.trigger,
    })
    .returning();
  return { trigger: trigger!, agentId: agent!.id, userId: owner!.id };
}

async function getTrigger(id: number): Promise<AgentTrigger> {
  const [row] = await db.select().from(agentTriggersTable).where(eq(agentTriggersTable.id, id));
  return row!;
}

const NOW = new Date("2026-11-24T07:00:30Z");

describe("fireSchedule", () => {
  it("mette in coda una run con le istruzioni e sposta la scadenza alla successiva", async () => {
    const { trigger, agentId } = await seed();
    const outcome = await fireSchedule(trigger.id, NOW);
    expect(outcome).toMatchObject({ runId: expect.any(Number) });
    const runs = await db.select().from(runsTable).where(eq(runsTable.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "pending", triggerId: trigger.id, hasUserToken: false });
    expect(runs[0]!.input).toBe(
      "Prepara il report delle email\n\nRun programmata «Report mattutino» del 24/11/2026 08:00 (ora italiana).",
    );
    const after = await getTrigger(trigger.id);
    expect(after.nextPollAt!.toISOString()).toBe("2026-11-25T07:00:00.000Z");
    expect(after.runsCreated).toBe(1);
    expect(after.lastPolledAt).not.toBeNull();
    expect(after.lastError).toBeNull();
  });

  it("una sola run per scadenza: la seconda chiamata non trova nulla di scaduto", async () => {
    const { trigger, agentId } = await seed();
    // L'ora vera, non NOW: la scadenza successiva deve cadere nel futuro rispetto a now() del DB, altrimenti la seconda
    // chiamata la troverebbe già scaduta (con NOW fisso il test fallirebbe dal giorno dopo NOW)
    const real = new Date();
    const [a, b] = await Promise.all([fireSchedule(trigger.id, real), fireSchedule(trigger.id, real)]);
    expect([a, b].filter((o) => o === "skipped")).toHaveLength(1);
    expect(await db.select().from(runsTable).where(eq(runsTable.agentId, agentId))).toHaveLength(1);
  });

  it("non scaduta, in pausa o di un altro tipo: niente", async () => {
    const future = await seed({ trigger: { nextPollAt: new Date(Date.now() + 3600_000) } });
    expect(await fireSchedule(future.trigger.id, NOW)).toBe("skipped");
    await db.update(agentTriggersTable).set({ nextPollAt: new Date("2026-11-24T07:00:00Z"), status: "paused" }).where(eq(agentTriggersTable.id, future.trigger.id));
    expect(await fireSchedule(future.trigger.id, NOW)).toBe("skipped");
    expect(await db.select().from(runsTable)).toHaveLength(0);
  });

  it("agente non attivo: scadenza saltata senza errore", async () => {
    const { trigger } = await seed({ agent: { status: "inactive" } });
    expect(await fireSchedule(trigger.id, NOW)).toBe("skipped");
    const after = await getTrigger(trigger.id);
    expect(after.nextPollAt!.toISOString()).toBe("2026-11-25T07:00:00.000Z");
    expect(after.consecutiveErrors).toBe(0);
    expect(await db.select().from(runsTable)).toHaveLength(0);
  });

  it("tetto di spesa: scadenza saltata con il motivo, nessuna run", async () => {
    budgetHook.fn = async () => "tetto raggiunto";
    const { trigger } = await seed();
    expect(await fireSchedule(trigger.id, NOW)).toBe("skipped");
    const after = await getTrigger(trigger.id);
    expect(after.lastError).toBe(TRIGGER_MESSAGES.budgetWait);
    expect(after.status).toBe("active");
    expect(await db.select().from(runsTable)).toHaveLength(0);
  });

  it("una scadenza persa da tempo vale una volta, poi la successiva da adesso", async () => {
    const { trigger, agentId } = await seed({ trigger: { nextPollAt: new Date("2026-11-20T07:00:00Z") } });
    await fireSchedule(trigger.id, NOW);
    expect(await db.select().from(runsTable).where(eq(runsTable.agentId, agentId))).toHaveLength(1);
    expect((await getTrigger(trigger.id)).nextPollAt!.toISOString()).toBe("2026-11-25T07:00:00.000Z");
  });
});

describe("servizio delle run programmate", () => {
  it("creazione in pausa con la prossima run, ripresa e cambio d'orario", async () => {
    const { agentId, userId } = await seed();
    const created = await createTrigger(agentId, userId, {
      kind: "schedule",
      name: "Controllo notturno",
      instructions: "Controlla gli errori",
      cron: "30 2 * * *",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { trigger, webhookUrl } = created.value;
    expect(webhookUrl).toBeNull();
    expect(trigger).toMatchObject({ kind: "schedule", status: "paused", cron: "30 2 * * *", toolId: null, intervalSeconds: null });
    expect(trigger.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

    const resumed = await resumeTrigger(trigger.id);
    expect(resumed!.status).toBe("active");
    // Ripresa: la prossima occorrenza, non subito
    expect(resumed!.nextPollAt!.getTime()).toBeGreaterThan(Date.now());

    const updated = await updateTrigger(trigger.id, { cron: "0 */6 * * *" });
    expect(updated).toMatchObject({ ok: true, value: { cron: "0 */6 * * *" } });
    if (!updated.ok) return;
    expect(updated.value.nextPollAt!.getTime()).toBeLessThanOrEqual(Date.now() + 6 * 3600_000);

    expect(await updateTrigger(trigger.id, { cron: "* * * * *" })).toMatchObject({ ok: false, status: 400, error: TRIGGER_MESSAGES.cronTooFrequent });
    expect(await updateTrigger(trigger.id, { toolId: 1 })).toMatchObject({ ok: false, status: 400, error: TRIGGER_MESSAGES.wrongKindFields });
    expect(await updateTrigger(trigger.id, { instructions: null })).toMatchObject({ ok: false, error: TRIGGER_MESSAGES.instructionsRequired });
  });
});
