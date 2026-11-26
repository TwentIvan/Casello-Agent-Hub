import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiAccountsTable, aiModelsTable, db, pool, teamInstancesTable, type InstanceRoleData } from "@workspace/db";
import { seedReleaseTest } from "../../../test/collaudo-fixture";
import { nodeModelFor } from "../../../test/node-turn-fixture";
import { ensureUser } from "../../../test/team-node-fixture";
import { encryptSecret } from "../secrets";
import { COLLAUDO_MESSAGES } from "./messages";
import { testModelFor } from "./model";

const savedKey = process.env["CASELLO_SECRET_KEY"];
let userId: number;

const lead = (aiModelId: number | null): InstanceRoleData => ({
  key: "capo",
  name: "Capo",
  task: "Coordina.",
  isLead: true,
  runsOn: "cloud",
  aiModelId,
  tools: [],
  skills: [],
  localSkills: [],
});

async function cloudModel(name = "Cloud"): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name, provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("k-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: `${name} m` }).returning();
  return model!.id;
}

async function instanceWithLead(aiModelId: number | null, cap: string | null = null) {
  const { testId } = await seedReleaseTest();
  const [inst] = await db.select().from(teamInstancesTable).limit(1);
  const [updated] = await db
    .update(teamInstancesTable)
    .set({ roles: [lead(aiModelId)], monthlyBudgetUsd: cap })
    .where(eq(teamInstancesTable.id, inst!.id))
    .returning();
  return { instance: updated!, testId };
}

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
  userId = await ensureUser("collaudo@example.com");
});

afterAll(async () => {
  process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE users, apps, ai_accounts, team_instances RESTART IDENTITY CASCADE");
});

describe("modello del collaudatore", () => {
  it("capo cloud: il suo modello", async () => {
    const id = await cloudModel();
    const { instance } = await instanceWithLead(id);
    const r = await testModelFor(instance);
    expect("skip" in r).toBe(false);
    if (!("skip" in r)) {
      expect(r.aiModelId).toBe(id);
      expect(r.resolved.kind).toBe("openai_compatible");
    }
  });

  it("capo senza modello: skip noModel", async () => {
    const { instance } = await instanceWithLead(null);
    expect(await testModelFor(instance)).toEqual({ skip: COLLAUDO_MESSAGES.noModel });
  });

  it("capo Claude Code (nodo) con ripiego: il ripiego", async () => {
    const fallback = await cloudModel("Ripiego");
    const node = await nodeModelFor(userId, { fallbackAiModelId: fallback });
    const { instance } = await instanceWithLead(node);
    const r = await testModelFor(instance);
    expect("skip" in r ? null : r.aiModelId).toBe(fallback);
  });

  it("capo Claude Code (nodo) senza ripiego: skip nodeNoFallback", async () => {
    const node = await nodeModelFor(userId);
    const { instance } = await instanceWithLead(node);
    expect(await testModelFor(instance)).toEqual({ skip: COLLAUDO_MESSAGES.nodeNoFallback });
  });

  it("tetto della squadra raggiunto: skip col motivo del tetto", async () => {
    const id = await cloudModel();
    const { instance } = await instanceWithLead(id, "0.00");
    const r = await testModelFor(instance);
    expect(r).toEqual({ skip: "tetto di spesa della squadra raggiunto" });
  });

  it("tetto della squadra raggiunto con il ripiego del nodo: skip col motivo del tetto", async () => {
    const fallback = await cloudModel("Ripiego");
    const node = await nodeModelFor(userId, { fallbackAiModelId: fallback });
    const { instance } = await instanceWithLead(node, "0.00");
    expect(await testModelFor(instance)).toEqual({ skip: "tetto di spesa della squadra raggiunto" });
  });
});
