import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  pool,
  agentSkillsTable,
  agentToolsTable,
  agentsTable,
  analysesTable,
  analysisItemsTable,
  appToolsTable,
  appsTable,
  type AnalysisItem,
} from "@workspace/db";
import { ApplyError, applyItem } from "./apply";
import type { ToolProposal } from "./schemas";

afterAll(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

const toolPayload = (over: Partial<ToolProposal> = {}): ToolProposal => ({
  name: "list_teams",
  description: "Elenco squadre",
  kind: "http",
  identity: "user",
  requiresConfirmation: false,
  readOnly: true,
  paramsSchema: { type: "object", properties: { q: { type: "string" } } },
  definition: { method: "GET", path: "/teams", paramLocations: { q: "query" } },
  area: "Squadre",
  evidence: [{ source: "code", location: "src/a.ts:1" }],
  needsVerification: true,
  ...over,
});

let appId: number;
let generalId: number;
let analysisId: number;
let seq = 0;

async function item(chapter: AnalysisItem["chapter"], diff: AnalysisItem["diff"], payload: unknown): Promise<AnalysisItem> {
  seq += 1;
  const [row] = await db
    .insert(analysisItemsTable)
    .values({ analysisId, chapter, ref: `${chapter}:${seq}`, position: seq, payload, diff })
    .returning();
  return row!;
}

const tools = () => db.select().from(appToolsTable).where(eq(appToolsTable.appId, appId));

beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  const [app] = await db
    .insert(appsTable)
    .values({ name: "App", slug: "app", baseUrl: "http://app.test" })
    .returning();
  appId = app!.id;
  const [general] = await db
    .insert(agentsTable)
    .values({ appId, name: "Generale", role: "general", status: "active", systemPrompt: "vecchio" })
    .returning();
  generalId = general!.id;
  const [analysis] = await db.insert(analysesTable).values({ appId, model: "openrouter/auto", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
    .returning();
  analysisId = analysis!.id;
});

const agentPayload = (over: Record<string, unknown> = {}) => ({
  role: "area",
  area: "Squadre",
  name: "Agente squadre",
  systemPrompt: "prompt",
  defaultIdentity: "service",
  toolNames: ["list_teams"],
  ...over,
});

describe("applyItem: tool", () => {
  it("un tool new valido viene creato active, con prove e verifica", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    const [t] = await tools();
    expect(t).toMatchObject({ name: "list_teams", status: "active", needsVerification: true, readOnly: true });
    expect(t!.evidence).toEqual([{ source: "code", location: "src/a.ts:1" }]);
  });

  it("segnaposto {teamId} non dichiarato: ApplyError e nessuna riga", async () => {
    const bad = toolPayload({ definition: { method: "GET", path: "/teams/{teamId}", paramLocations: {} } });
    await expect(applyItem(await item("tool", "new", bad), appId)).rejects.toBeInstanceOf(ApplyError);
    expect(await tools()).toHaveLength(0);
  });

  it("payload modificato e non più valido: ApplyError in italiano", async () => {
    await expect(applyItem(await item("tool", "new", { ...toolPayload(), name: "no no" }), appId)).rejects.toThrow(
      /nome non valido/,
    );
  });

  it("nome duplicato: ApplyError", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await expect(applyItem(await item("tool", "new", toolPayload()), appId)).rejects.toThrow(/Esiste già/);
    expect(await tools()).toHaveLength(1);
  });

  it("changed aggiorna e riattiva un tool disattivato, ma conserva draft", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await db.update(appToolsTable).set({ status: "disabled" }).where(eq(appToolsTable.appId, appId));
    await applyItem(await item("tool", "changed", toolPayload({ description: "nuova", readOnly: false })), appId);
    expect((await tools())[0]).toMatchObject({ description: "nuova", readOnly: false, status: "active" });
    await db.update(appToolsTable).set({ status: "draft" }).where(eq(appToolsTable.appId, appId));
    await applyItem(await item("tool", "changed", toolPayload({ description: "ancora" })), appId);
    expect((await tools())[0]).toMatchObject({ description: "ancora", status: "draft" });
  });

  it("removed mette disabled e non cancella", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    const [existing] = await tools();
    await applyItem(await item("tool", "removed", existing), appId);
    const rows = await tools();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("disabled");
  });
});

describe("applyItem: agenti", () => {
  it("l'agente generale aggiorna prompt e identità, senza collegamenti", async () => {
    await applyItem(
      await item("agent", "changed", agentPayload({ role: "general", area: null, name: "Altro", toolNames: ["x"] })),
      appId,
    );
    const [g] = await db.select().from(agentsTable).where(eq(agentsTable.id, generalId));
    expect(g).toMatchObject({ systemPrompt: "prompt", defaultIdentity: "service", name: "Generale" });
    expect(await db.select().from(agentToolsTable)).toHaveLength(0);
  });

  it("un agente di area nuovo è draft e collega esattamente i tool nominati", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    const [a] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    expect(a).toMatchObject({ status: "draft", area: "Squadre", model: "openrouter/auto" });
    expect(await db.select().from(agentToolsTable).where(eq(agentToolsTable.agentId, a!.id))).toHaveLength(1);
    // Aggiornamento: i collegamenti vengono sostituiti
    await applyItem(await item("agent", "changed", agentPayload({ toolNames: [], name: "Rinominato" })), appId);
    const [b] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    expect(b!.name).toBe("Rinominato");
    expect(await db.select().from(agentToolsTable)).toHaveLength(0);
  });

  it("tool inesistente: ApplyError e nessun agente creato", async () => {
    await expect(applyItem(await item("agent", "new", agentPayload({ toolNames: ["fantasma"] })), appId)).rejects.toThrow(
      /"fantasma"/,
    );
    expect(await db.select().from(agentsTable).where(eq(agentsTable.role, "area"))).toHaveLength(0);
  });

  it("tool non active: ApplyError che lo nomina", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await db.update(appToolsTable).set({ status: "draft" }).where(eq(appToolsTable.appId, appId));
    await expect(applyItem(await item("agent", "new", agentPayload()), appId)).rejects.toThrow(/"list_teams"/);
    expect(await db.select().from(agentsTable).where(eq(agentsTable.role, "area"))).toHaveLength(0);
  });

  it("incoerenza ruolo/area: ApplyError", async () => {
    await expect(applyItem(await item("agent", "new", agentPayload({ role: "general", area: "X" })), appId)).rejects.toBeInstanceOf(ApplyError);
    await expect(applyItem(await item("agent", "new", agentPayload({ area: null })), appId)).rejects.toBeInstanceOf(ApplyError);
    await expect(applyItem(await item("agent", "new", agentPayload({ area: "  " })), appId)).rejects.toBeInstanceOf(ApplyError);
  });
});

describe("applyItem: skill", () => {
  const skillPayload = (over: Record<string, unknown> = {}) => ({
    agentRole: "area",
    agentArea: "Squadre",
    name: "crea_squadra",
    description: "d",
    instructions: "i",
    toolNames: ["list_teams"],
    paramsSchema: null,
    ...over,
  });

  it("skill su agente inesistente: ApplyError", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await expect(applyItem(await item("skill", "new", skillPayload()), appId)).rejects.toThrow(/non esiste/);
    expect(await db.select().from(agentSkillsTable)).toHaveLength(0);
  });

  it("tool non dell'app: ApplyError che lo nomina", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    await expect(applyItem(await item("skill", "new", skillPayload({ toolNames: ["altrove"] })), appId)).rejects.toThrow(
      /"altrove"/,
    );
  });

  it("crea e poi aggiorna la skill sull'agente giusto; area su general rifiutata", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    await applyItem(await item("skill", "new", skillPayload()), appId);
    await applyItem(await item("skill", "changed", skillPayload({ instructions: "nuove" })), appId);
    const rows = await db.select().from(agentSkillsTable).where(and(eq(agentSkillsTable.name, "crea_squadra")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ instructions: "nuove", toolNames: ["list_teams"] });
    await expect(
      applyItem(await item("skill", "new", skillPayload({ agentRole: "general", agentArea: "X" })), appId),
    ).rejects.toBeInstanceOf(ApplyError);
  });
});

describe("applyItem: capitoli senza scritture", () => {
  it("endpoint, completion ed evolution non scrivono nulla", async () => {
    await applyItem(await item("endpoint", "new", { qualunque: 1 }), appId);
    await applyItem(await item("completion", "new", {}), appId);
    expect(await tools()).toHaveLength(0);
  });
});
