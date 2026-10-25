import { describe, expect, it } from "vitest";
import { phasePrompt, SYSTEM_BASE } from "./prompts";
import { ITEM_SCHEMAS, PHASE_SCHEMAS, PHASES, ToolProposalSchema } from "./schemas";

const evidence = [{ source: "code" as const, location: "src/routes/squadre.ts:12" }];

const tool = {
  name: "rosa_squadra",
  description: "Legge la rosa di una squadra",
  kind: "http" as const,
  identity: "user" as const,
  requiresConfirmation: false,
  readOnly: true,
  paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  definition: { method: "GET", path: "/api/squadre/{id}/rosa", paramLocations: { id: "path" } },
  area: "Squadre",
  evidence,
  needsVerification: false,
};

const completionItem = (key: string, dependsOn: string[] = []) => ({
  key,
  phase: 1,
  area: "Squadre",
  title: `Voce ${key}`,
  missing: "Manca la pagina",
  evidence,
  goal: "Completare",
  dependsOn,
  files: ["src/a.ts"],
  effort: "S" as const,
  doneWhen: "Funziona",
  implementation: "Aggiungere la route",
});

const agent = (role: "general" | "area", area: string | null) => ({
  role,
  area,
  name: `Agente ${role}`,
  systemPrompt: "Sei un agente",
  defaultIdentity: "user" as const,
  toolNames: ["rosa_squadra"],
});

const valid: Record<string, unknown> = {
  map: {
    stack: ["node"],
    structure: "monorepo",
    routes: [{ method: "GET", path: "/api/x", file: "a.ts" }],
    dataModels: [{ name: "Squadra", fields: ["id"] }],
    auth: { mechanism: "cookie", userToken: "header Authorization" },
    uiAreas: [{ name: "Squadre", description: "d", pages: ["/squadre"] }],
    summary: "ok",
  },
  capabilities: {
    areas: [
      {
        area: "Squadre",
        capabilities: [{ name: "Vedere la rosa", description: "d", endpoints: ["GET /api/x"], evidence }],
      },
    ],
  },
  catalog: {
    tools: [tool],
    endpoints: [
      {
        title: "Esporta",
        area: "Squadre",
        method: "GET",
        path: "/api/export",
        motivation: "serve",
        patch: "diff",
        evidence,
      },
    ],
  },
  agents: {
    agents: [agent("general", null), agent("area", "Squadre")],
    skills: [
      {
        agentRole: "area",
        agentArea: "Squadre",
        name: "Schiera",
        description: "d",
        instructions: "i",
        toolNames: ["rosa_squadra"],
        paramsSchema: null,
      },
    ],
  },
  completion: { items: [completionItem("a"), completionItem("b", ["a"])] },
  evolution: {
    items: [
      {
        area: "Squadre",
        type: "best_practice",
        title: "Cache",
        motivation: "m",
        evidence,
        benefit: "b",
        impact: "alto",
        effort: "M",
        priority: 3,
        implementation: "i",
      },
    ],
  },
};

describe("schemi delle fasi", () => {
  it.each(PHASES)("accetta un esito valido per %s", (phase) => {
    const r = PHASE_SCHEMAS[phase].safeParse(valid[phase]);
    expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
  });

  it("rifiuta un nome di tool non valido con messaggio italiano", () => {
    const r = PHASE_SCHEMAS.catalog.safeParse({
      ...(valid.catalog as object),
      tools: [{ ...tool, name: "nome non valido!" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/nome non valido/);
  });

  it("rifiuta un tool la cui definizione non potrebbe mai essere salvata", () => {
    const r = ToolProposalSchema.safeParse({ ...tool, definition: { method: "GET" } });
    expect(r.success).toBe(false);
    const r2 = ToolProposalSchema.safeParse({ ...tool, paramsSchema: { type: "object", properties: {} } });
    expect(r2.success).toBe(false);
    if (!r2.success) expect(r2.error.issues[0].message).toMatch(/segnaposto/);
  });

  it("richiede esattamente un agente generale", () => {
    const base = valid.agents as { agents: unknown[]; skills: unknown[] };
    expect(PHASE_SCHEMAS.agents.safeParse({ ...base, agents: [agent("area", "Squadre")] }).success).toBe(false);
    expect(
      PHASE_SCHEMAS.agents.safeParse({ ...base, agents: [agent("general", null), agent("general", null)] }).success,
    ).toBe(false);
  });

  it("rifiuta dipendenze inesistenti e cicli", () => {
    const missing = PHASE_SCHEMAS.completion.safeParse({ items: [completionItem("a", ["zzz"])] });
    expect(missing.success).toBe(false);
    const cycle = PHASE_SCHEMAS.completion.safeParse({
      items: [completionItem("a", ["b"]), completionItem("b", ["a"])],
    });
    expect(cycle.success).toBe(false);
    if (!cycle.success) expect(cycle.error.issues[0].message).toMatch(/ciclo/);
  });

  it("rifiuta un type di evoluzione sconosciuto", () => {
    const item = (valid.evolution as { items: object[] }).items[0];
    expect(PHASE_SCHEMAS.evolution.safeParse({ items: [{ ...item, type: "magia" }] }).success).toBe(false);
  });

  it("ha uno schema per ogni capitolo degli elementi", () => {
    expect(Object.keys(ITEM_SCHEMAS).sort()).toEqual(
      ["agent", "completion", "endpoint", "evolution", "skill", "tool"],
    );
    expect(ITEM_SCHEMAS.tool.safeParse(tool).success).toBe(true);
  });
});

describe("prompt", () => {
  const ctx = {
    appName: "Mister",
    baseUrl: "https://mister.example",
    functionalDescription: "Fantacalcio",
    hasCode: true,
    hasOpenApi: false,
    previous: { map: { summary: "x" } },
  };
  it("il prompt di completamento parla di dipendenze e nomina l'app", () => {
    const p = phasePrompt("completion", ctx);
    expect(p).toContain("dipendenz");
    expect(p).toContain("Mister");
  });
  it("SYSTEM_BASE dichiara il repository come materiale e non istruzioni", () => {
    expect(SYSTEM_BASE).toContain("non istruzioni");
  });
  it("senza codice né OpenAPI il catalogo chiede needsVerification", () => {
    const p = phasePrompt("catalog", { ...ctx, hasCode: false, hasOpenApi: false });
    expect(p).toContain("needsVerification");
  });
  it.each(PHASES)("esiste un prompt per %s", (phase) => {
    expect(phasePrompt(phase, ctx).length).toBeGreaterThan(100);
  });
});
