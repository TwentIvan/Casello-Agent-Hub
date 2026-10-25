import { describe, expect, it } from "vitest";
import type { Agent, AgentSkill, AppTool } from "@workspace/db";
import { diffAgents, diffAlwaysNew, diffSkills, diffTools, skillRef } from "./diff";
import { AgentsResultSchema, type AgentProposal, type SkillProposal, type ToolProposal } from "./schemas";

const proposal = (over: Partial<ToolProposal> = {}): ToolProposal => ({
  name: "list_teams",
  description: "Elenco squadre",
  kind: "http",
  identity: "user",
  requiresConfirmation: false,
  readOnly: true,
  paramsSchema: { type: "object", properties: { q: { type: "string" } } },
  definition: { method: "GET", path: "/teams", paramLocations: { q: "query" } },
  area: "Squadre",
  evidence: [],
  needsVerification: false,
  ...over,
});

const existingTool = (over: Partial<AppTool> = {}): AppTool => ({
  id: 1,
  appId: 1,
  name: "list_teams",
  description: "Elenco squadre",
  kind: "http",
  identity: "user",
  requiresConfirmation: false,
  readOnly: true,
  status: "active",
  // chiavi in ordine diverso: jsonb non conserva l'ordine
  paramsSchema: { properties: { q: { type: "string" } }, type: "object" },
  definition: { paramLocations: { q: "query" }, path: "/teams", method: "GET" },
  evidence: null,
  needsVerification: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("diffTools", () => {
  it("riconosce new, changed, unchanged e removed", () => {
    const result = diffTools(
      [proposal(), proposal({ name: "nuovo" }), proposal({ name: "cambiato", description: "altro" })],
      [
        existingTool(),
        existingTool({ id: 2, name: "cambiato" }),
        existingTool({ id: 3, name: "sparito" }),
        existingTool({ id: 4, name: "gia_spento", status: "disabled" }),
      ],
    );
    expect(result.map((r) => [r.ref, r.diff])).toEqual([
      ["tool:list_teams", "unchanged"],
      ["tool:nuovo", "new"],
      ["tool:cambiato", "changed"],
      ["tool:sparito", "removed"],
    ]);
    expect((result[3]!.payload as AppTool).id).toBe(3);
  });

  it("è changed se cambia un campo di comportamento", () => {
    for (const over of [
      { requiresConfirmation: true },
      { readOnly: false },
      { identity: "service" as const },
      { definition: { method: "GET", path: "/squadre", paramLocations: { q: "query" } } },
    ]) {
      expect(diffTools([proposal(over)], [existingTool()])[0]!.diff).toBe("changed");
    }
  });
});

const agent = (over: Partial<AgentProposal> = {}): AgentProposal => ({
  role: "area",
  area: "Squadre",
  name: "Agente squadre",
  systemPrompt: "p",
  defaultIdentity: "user",
  toolNames: ["a", "b"],
  ...over,
});
const existingAgent = (over: Partial<Agent & { toolNames: string[] }> = {}) => ({
  id: 1,
  appId: 1,
  name: "Agente squadre",
  systemPrompt: "p",
  model: "openrouter/auto",
  status: "active" as const,
  role: "area" as const,
  area: "Squadre",
  defaultIdentity: "user" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  toolNames: ["b", "a"],
  ...over,
});

describe("diffAgents e diffSkills", () => {
  it("agenti: per ruolo e area, tool in qualunque ordine", () => {
    const r = diffAgents(
      [agent(), agent({ area: "Altro" }), agent({ role: "general", area: null, systemPrompt: "nuovo", toolNames: [] })],
      [existingAgent(), existingAgent({ id: 2, role: "general", area: null, name: "Generale", toolNames: [] })],
    );
    expect(r.map((x) => [x.ref, x.diff])).toEqual([
      ["agent:area:Squadre", "unchanged"],
      ["agent:area:Altro", "new"],
      ["agent:general", "changed"],
    ]);
  });

  it("agenti: area con spazi e tool duplicati non lasciano 'changed'", () => {
    const r = diffAgents(
      [agent({ area: " Squadre ", toolNames: ["a", "a", "b"] })],
      [existingAgent()],
    );
    expect(r[0]).toMatchObject({ ref: "agent:area:Squadre", diff: "unchanged" });
  });

  it("skill: per agente e nome", () => {
    const skill = (over: Partial<SkillProposal> = {}): SkillProposal => ({
      agentRole: "area",
      agentArea: "Squadre",
      name: "s",
      description: "d",
      instructions: "i",
      toolNames: ["a"],
      paramsSchema: null,
      ...over,
    });
    const existing = {
      id: 1,
      agentId: 1,
      name: "s",
      description: "d",
      instructions: "i",
      toolNames: ["a"],
      paramsSchema: null,
      status: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      agentRole: "area",
      agentArea: "Squadre",
    } satisfies AgentSkill & { agentRole: string; agentArea: string | null };
    const r = diffSkills([skill(), skill({ instructions: "x" }), skill({ name: "t" })], [existing]);
    expect(r.map((x) => x.diff)).toEqual(["unchanged", "changed", "new"]);
  });

  it("endpoint, completion ed evoluzione sono sempre new", () => {
    const r = diffAlwaysNew({
      chapter: "evolution",
      items: [{ title: "t" } as never, { title: "u" } as never],
    });
    expect(r.map((x) => [x.ref, x.diff])).toEqual([
      ["evolution:1", "new"],
      ["evolution:2", "new"],
    ]);
  });
});

describe("skillRef", () => {
  const skill = (agentArea: string, name: string) => ({
    agentRole: "area",
    agentArea,
    name,
    description: "d",
    instructions: "i",
    toolNames: [],
    paramsSchema: null,
  });
  const agents = [
    { role: "general", area: null, name: "G", systemPrompt: "p", defaultIdentity: "user", toolNames: [] },
  ];

  it("il separatore non è ambiguo: area \"a:b\" + \"c\" ≠ area \"a\" + \"b:c\"", () => {
    expect(skillRef("area", "a:b", "c")).not.toBe(skillRef("area", "a", "b:c"));
    // e lo schema non le considera duplicate
    expect(AgentsResultSchema.safeParse({ agents, skills: [skill("a:b", "c"), skill("a", "b:c")] }).success).toBe(true);
  });

  it("area con spazi ai bordi: stesso riferimento e duplicato per lo schema", () => {
    expect(skillRef("area", " Squadre ", "s")).toBe(skillRef("area", "Squadre", "s"));
    expect(skillRef("area", "Squadre", "s")).toBe("skill:area:Squadre:s");
    expect(skillRef("general", null, "s")).toBe("skill:general:s");
    expect(skillRef("general", null, "s")).not.toBe(skillRef("area", "general", "s"));
    const dup = AgentsResultSchema.safeParse({ agents, skills: [skill(" Squadre ", "s"), skill("Squadre", "s")] });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(dup.error.issues[0]!.message).toContain('"Squadre/s"');
  });
});
