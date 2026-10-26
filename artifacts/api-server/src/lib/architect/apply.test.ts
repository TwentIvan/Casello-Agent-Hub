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
  aiModelsTable,
  type AnalysisItem,
} from "@workspace/db";
import { ensureSystemAccount } from "../ai/system-account";
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

  it("changed aggiorna e rende active un tool disattivato o in bozza", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await db.update(appToolsTable).set({ status: "disabled" }).where(eq(appToolsTable.appId, appId));
    await applyItem(await item("tool", "changed", toolPayload({ description: "nuova", readOnly: false })), appId);
    expect((await tools())[0]).toMatchObject({ description: "nuova", readOnly: false, status: "active" });
    await db.update(appToolsTable).set({ status: "draft" }).where(eq(appToolsTable.appId, appId));
    await applyItem(await item("tool", "changed", toolPayload({ description: "ancora" })), appId);
    expect((await tools())[0]).toMatchObject({ description: "ancora", status: "active" });
  });

  it("unchanged rende active un tool in bozza; poi un agente di area che lo usa si approva", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    const old = new Date("2026-01-01T00:00:00Z");
    await db.update(appToolsTable).set({ status: "draft", updatedAt: old }).where(eq(appToolsTable.appId, appId));
    await expect(applyItem(await item("agent", "new", agentPayload()), appId)).rejects.toThrow(/non è attivo/);
    await applyItem(await item("tool", "unchanged", toolPayload()), appId);
    const [t] = await tools();
    expect(t).toMatchObject({ status: "active", description: toolPayload().description });
    expect(t!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    await applyItem(await item("agent", "new", agentPayload()), appId);
    const [a] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    expect(a!.status).toBe("active");
  });

  it("unchanged di un tool che non esiste più: ApplyError", async () => {
    await expect(applyItem(await item("tool", "unchanged", toolPayload()), appId)).rejects.toThrow(/non esiste/);
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
  it("l'agente generale aggiorna prompt e identità e diventa active, senza collegamenti", async () => {
    await db.update(agentsTable).set({ status: "draft" }).where(eq(agentsTable.id, generalId));
    await applyItem(
      await item("agent", "changed", agentPayload({ role: "general", area: null, name: "Altro", toolNames: ["x"] })),
      appId,
    );
    const [g] = await db.select().from(agentsTable).where(eq(agentsTable.id, generalId));
    expect(g).toMatchObject({ systemPrompt: "prompt", defaultIdentity: "service", name: "Generale", status: "active" });
    expect(await db.select().from(agentToolsTable)).toHaveLength(0);
  });

  it("un agente di area nuovo è active e collega esattamente i tool nominati", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    const [a] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    expect(a).toMatchObject({ status: "active", area: "Squadre", model: "openrouter/auto" });
    expect(await db.select().from(agentToolsTable).where(eq(agentToolsTable.agentId, a!.id))).toHaveLength(1);
    // Aggiornamento: i collegamenti vengono sostituiti e l'agente torna active
    await db.update(agentsTable).set({ status: "inactive" }).where(eq(agentsTable.id, a!.id));
    await applyItem(await item("agent", "changed", agentPayload({ toolNames: [], name: "Rinominato" })), appId);
    const [b] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    expect(b).toMatchObject({ name: "Rinominato", status: "active" });
    expect(await db.select().from(agentToolsTable)).toHaveLength(0);
  });

  it("un agente di area nuovo nasce collegato al modello predefinito di sistema; senza sistema resta null", async () => {
    const saved = { url: process.env["AI_GATEWAY_BASE_URL"], key: process.env["AI_GATEWAY_API_KEY"] };
    try {
      process.env["AI_GATEWAY_BASE_URL"] = "http://gateway.interno:4000/v1";
      process.env["AI_GATEWAY_API_KEY"] = "sk-gateway-di-prova";
      await ensureSystemAccount();
      const [sys] = await db.select({ id: aiModelsTable.id }).from(aiModelsTable).where(eq(aiModelsTable.modelId, "openrouter/auto"));
      await applyItem(await item("tool", "new", toolPayload()), appId);
      await applyItem(await item("agent", "new", agentPayload()), appId);
      const [linked] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
      expect(linked!.aiModelId).toBe(sys!.id);

      // Variabili del gateway assenti: il modello di sistema non è utilizzabile, nessun collegamento
      delete process.env["AI_GATEWAY_API_KEY"];
      await applyItem(await item("agent", "new", agentPayload({ area: "Partite", name: "Agente partite", toolNames: [] })), appId);
      const [unlinked] = await db.select().from(agentsTable).where(eq(agentsTable.area, "Partite"));
      expect(unlinked!.aiModelId).toBeNull();
    } finally {
      for (const [k, v] of [["AI_GATEWAY_BASE_URL", saved.url], ["AI_GATEWAY_API_KEY", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await pool.query("TRUNCATE apps, ai_accounts RESTART IDENTITY CASCADE");
    }
  });

  it("unchanged rende active l'agente senza toccarne i contenuti", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    await db.update(agentsTable).set({ status: "draft" });
    await applyItem(await item("agent", "unchanged", agentPayload({ systemPrompt: "ignorato" })), appId);
    await applyItem(await item("agent", "unchanged", agentPayload({ role: "general", area: null })), appId);
    const rows = await db.select().from(agentsTable).orderBy(agentsTable.id);
    expect(rows.map((r) => r.status)).toEqual(["active", "active"]);
    expect(rows[1]!.systemPrompt).toBe("prompt");
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

describe("applyItem: transazione", () => {
  it("rollback: se i collegamenti falliscono dopo l'update, l'agente resta com'era", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    const [before] = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    // Trigger che fa fallire l'inserimento dei collegamenti, quando l'agente è già stato aggiornato
    await pool.query(`
      CREATE FUNCTION fail_links() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'collegamenti rifiutati'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_links BEFORE INSERT ON agent_tools FOR EACH ROW EXECUTE FUNCTION fail_links();
    `);
    try {
      await expect(
        applyItem(await item("agent", "changed", agentPayload({ name: "Rinominato", toolNames: ["list_teams"] })), appId),
      ).rejects.toThrow();
    } finally {
      await pool.query("DROP TRIGGER fail_links ON agent_tools; DROP FUNCTION fail_links();");
    }
    const [after] = await db.select().from(agentsTable).where(eq(agentsTable.id, before!.id));
    expect(after!.name).toBe("Agente squadre");
    expect(await db.select().from(agentToolsTable).where(eq(agentToolsTable.agentId, before!.id))).toHaveLength(1);
  });

  it("con una tx del chiamante non ne apre un'altra: il rollback esterno annulla tutto", async () => {
    const it1 = await item("tool", "new", toolPayload());
    await expect(
      db.transaction(async (tx) => {
        await applyItem(it1, appId, tx);
        expect(await tx.select().from(appToolsTable)).toHaveLength(1);
        throw new Error("annulla");
      }),
    ).rejects.toThrow("annulla");
    expect(await tools()).toHaveLength(0);
  });

  it("violazione di unicità non prevista: ApplyError in italiano", async () => {
    await applyItem(await item("tool", "new", toolPayload()), appId);
    await applyItem(await item("agent", "new", agentPayload()), appId);
    await pool.query(`
      CREATE FUNCTION dup_skill() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'dup' USING ERRCODE = '23505', CONSTRAINT = 'agent_skills_agent_id_name_unique';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER dup_skill BEFORE INSERT ON agent_skills FOR EACH ROW EXECUTE FUNCTION dup_skill();
    `);
    try {
      const skill = {
        agentRole: "area", agentArea: "Squadre", name: "s", description: "d", instructions: "i",
        toolNames: ["list_teams"], paramsSchema: null,
      };
      await expect(applyItem(await item("skill", "new", skill), appId)).rejects.toThrow(/Esiste già una skill/);
    } finally {
      await pool.query("DROP TRIGGER dup_skill ON agent_skills; DROP FUNCTION dup_skill();");
    }
  });
});

describe("applyItem: altra app e aree con spazi", () => {
  it("un tool con lo stesso nome in un'altra app non si collega", async () => {
    const [other] = await db.insert(appsTable).values({ name: "B", slug: "b", baseUrl: "http://b.test" }).returning();
    await db.insert(appToolsTable).values({
      appId: other!.id, name: "solo_b", kind: "http", status: "active",
      definition: { method: "GET", path: "/x", paramLocations: {} },
    });
    await expect(applyItem(await item("agent", "new", agentPayload({ toolNames: ["solo_b"] })), appId)).rejects.toThrow(
      /"solo_b"/,
    );
    expect(await db.select().from(agentsTable).where(eq(agentsTable.role, "area"))).toHaveLength(0);
  });

  it("l'area si salva e si confronta senza spazi", async () => {
    await applyItem(await item("agent", "new", agentPayload({ area: " Squadre ", toolNames: [] })), appId);
    await applyItem(await item("agent", "changed", agentPayload({ area: "Squadre", toolNames: [], name: "Bis" })), appId);
    const rows = await db.select().from(agentsTable).where(eq(agentsTable.role, "area"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ area: "Squadre", name: "Bis" });
  });
});
