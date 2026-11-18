import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  agentsTable,
  appsTable,
  bugReportsTable,
  leadConversationsTable,
  leadMessagesTable,
  pendingActionsTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { PAGE_SEEN_MAX, PAGE_SEEN_WRITE_MS, embedStatus, recordPageSeen, resetPageSeen } from "./status";

// Stato del pannello: contatori, azioni del tipo di pagina, Responsabile al lavoro; elenco dei tipi di pagina visti.

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  resetPageSeen();
});

async function seen(appId: number): Promise<string[]> {
  const [row] = await db.select({ s: appsTable.embedPagesSeen }).from(appsTable).where(eq(appsTable.id, appId));
  return row!.s;
}

describe("recordPageSeen", () => {
  it("due tipi di pagina entro un minuto: una sola scrittura; poi la seconda", async () => {
    const [app] = await db.insert(appsTable).values({ name: "Hub", slug: "hub", baseUrl: "https://hub.example" }).returning();
    await recordPageSeen(app!.id, "task", 1_000);
    await recordPageSeen(app!.id, "project", 1_000 + PAGE_SEEN_WRITE_MS - 1);
    expect(await seen(app!.id)).toEqual(["task"]);
    await recordPageSeen(app!.id, "project", 1_000 + PAGE_SEEN_WRITE_MS);
    expect(await seen(app!.id)).toEqual(["project", "task"]);
  });

  it("un tipo già in testa non si riscrive; uno già presente sale in testa senza ripetersi", async () => {
    const [app] = await db.insert(appsTable).values({ name: "Hub", slug: "hub", baseUrl: "https://hub.example" }).returning();
    let t = 0;
    for (const p of ["a", "b", "a", "a"]) await recordPageSeen(app!.id, p, (t += PAGE_SEEN_WRITE_MS));
    expect(await seen(app!.id)).toEqual(["a", "b"]);
  });

  it("51 tipi diversi in minuti diversi: restano 50, il più vecchio cade", async () => {
    const [app] = await db.insert(appsTable).values({ name: "Hub", slug: "hub", baseUrl: "https://hub.example" }).returning();
    for (let i = 0; i <= PAGE_SEEN_MAX; i++) await recordPageSeen(app!.id, `p${i}`, (i + 1) * PAGE_SEEN_WRITE_MS);
    const list = await seen(app!.id);
    expect(list).toHaveLength(PAGE_SEEN_MAX);
    expect(list[0]).toBe(`p${PAGE_SEEN_MAX}`);
    expect(list).not.toContain("p0");
  });
});

let seq = 0;
async function seedUser() {
  const [user] = await db.insert(usersTable).values({ email: `st${++seq}@example.com`, name: "U" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: user!.id, name: `A${seq}`, provider: "custom", baseUrl: "https://llm.example/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  return { userId: user!.id, modelId: model!.id };
}

describe("embedStatus", () => {
  it("azioni del tipo di pagina, nomi dei bot, segnalazioni da vagliare e voci dell'utente", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const [app] = await db
      .insert(appsTable)
      .values({
        name: "Hub",
        slug: "hub",
        baseUrl: "https://hub.example",
        leadName: "Gina",
        pageActions: [
          { page: "task", label: "Esegui", request: "r1" },
          { page: "project", label: "Riassumi", request: "r2" },
          { page: "task", label: "Controlla", request: "r3" },
        ],
      })
      .returning();
    const base = { appId: app!.id, reporterKind: "browser" as const, title: "t", description: "d" };
    await db.insert(bugReportsTable).values([
      { ...base, number: 1, status: "received" },
      { ...base, number: 2, status: "triage" },
      { ...base, number: 3, status: "in_progress" },
      { ...base, number: 4, status: "fixed" },
    ]);
    const item = { kind: "plan" as const, argsEnc: "x", argsPublic: {}, recipient: "r", summary: "s" };
    await db.insert(pendingActionsTable).values([
      { ...item, userId: me.userId, number: 1 },
      { ...item, userId: me.userId, number: 2, status: "rejected" as const },
      { ...item, userId: other.userId, number: 1 },
    ]);

    const s = await embedStatus(me.userId, app!, "task");
    expect(s).toMatchObject({ pending: 1, bugs: 2, leadAvailable: false, leadWorking: false });
    expect(s.actions).toEqual([{ label: "Esegui" }, { label: "Controlla" }]);
    expect(s.botNames).toEqual({ alfred: "Alfred", lucius: "Lucius", lead: "Gina" });
    expect((await embedStatus(me.userId, app!, "altro")).actions).toEqual([]);
  });

  it("leadWorking: vero con una run del Responsabile pending o running di una conversazione dell'utente su quell'App", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const [app] = await db.insert(appsTable).values({ name: "Hub", slug: "hub", baseUrl: "https://hub.example" }).returning();
    const [otherApp] = await db.insert(appsTable).values({ name: "Altra", slug: "altra", baseUrl: "https://altra.example" }).returning();
    const lead = async (appId: number) =>
      (await db.insert(agentsTable).values({ appId, name: "Responsabile", role: "general", status: "active", aiModelId: me.modelId }).returning())[0]!;
    const leadHub = await lead(app!.id);
    const leadOther = await lead(otherApp!.id);

    async function message(userId: number, appId: number, agentId: number, status: "pending" | "running" | "succeeded") {
      const [conv] = await db.insert(leadConversationsTable).values({ userId, agentId, appId }).returning();
      const [run] = await db.insert(runsTable).values({ agentId, status }).returning();
      await db.insert(leadMessagesTable).values({ conversationId: conv!.id, content: "ciao", runId: run!.id });
    }

    await message(me.userId, app!.id, leadHub.id, "succeeded");
    await message(other.userId, app!.id, leadHub.id, "running");
    await message(me.userId, otherApp!.id, leadOther.id, "running");
    const idle = await embedStatus(me.userId, app!, "task");
    expect(idle.leadWorking).toBe(false);
    expect(idle.leadAvailable).toBe(true);

    await message(me.userId, app!.id, leadHub.id, "pending");
    expect((await embedStatus(me.userId, app!, "task")).leadWorking).toBe(true);
  });
});
