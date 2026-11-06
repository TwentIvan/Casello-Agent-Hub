import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentToolsTable,
  agentsTable,
  appToolsTable,
  appsTable,
  characterMessagesTable,
  characterConversationsTable,
  characterProposalsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { encryptSecret } from "../../secrets";
import { createSkill, updateSkill } from "../../teams/skills";
import { insertTemplateUnchecked, appendTemplateVersionUnchecked } from "../../teams/templates";
import { createTurnContext } from "../proposals";
import { findSubject } from "../registry";
import { startCharacterTurn } from "../run-turn";
import type { SubjectType, TurnContext } from "../types";
import { subjectHash } from "./hash";
import "./index";

const saved = process.env["CASELLO_SECRET_KEY"];
process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);

let userId: number;
let appId: number;
let agentId: number;
let generalId: number;
let toolId: number;

const handler = (t: SubjectType) => findSubject(t)!;
const call = (t: SubjectType, ctx: TurnContext, name: string, args: unknown) =>
  handler(t).runTool({ id: "c", name, arguments: JSON.stringify(args) }, ctx).then((s) => JSON.parse(s) as { ok: boolean; result?: any; error?: string });

async function newCtx(type: SubjectType, subjectId: string | null): Promise<TurnContext> {
  const [conv] = await db
    .insert(characterConversationsTable)
    .values({ userId, character: "lucius", subjectType: type, subjectId, subjectTitle: "t", title: "" })
    .returning();
  const [m] = await db.insert(characterMessagesTable).values({ conversationId: conv!.id, role: "assistant", content: "" }).returning();
  return createTurnContext({ userId, conversationId: conv!.id, messageId: m!.id, subjectId });
}

const role = (over: Record<string, unknown> = {}) => ({ key: "capo", name: "Capo", task: "Guida", isLead: true, runsOn: "node", aiModelId: null, tools: [], skills: [], ...over });
const RATIONALE = "perché serve";

beforeEach(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users, skills, team_templates RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "a@x.it", name: "A" }).returning();
  userId = u!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://base-segreta.example", internalBaseUrl: "http://interno-segreto.example", serviceSecretEnc: encryptSecret("SEGRETO-DI-SERVIZIO"), authHeader: "X-Chiave-App" } as never)
    .returning();
  appId = app!.id;
  const [ag] = await db.insert(agentsTable).values({ appId, name: "Cassa", role: "area", systemPrompt: "Prompt iniziale" }).returning();
  agentId = ag!.id;
  const [gen] = await db.insert(agentsTable).values({ appId, name: "Generale", role: "general" }).returning();
  generalId = gen!.id;
  const [tool] = await db
    .insert(appToolsTable)
    .values({
      appId,
      name: "cambia_password",
      kind: "http",
      identity: "user",
      level: "L2",
      status: "active",
      paramsSchema: { type: "object", properties: { password: { type: "string", "x-sensitive": true, default: "hunter2", description: "la password" }, nome: { type: "string" } } },
      definition: { method: "POST", path: "/x", paramLocations: {}, headers: { Authorization: "Bearer SEGRETO-HEADER" } },
    } as InsertAppTool)
    .returning();
  toolId = tool!.id;
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users, skills, team_templates RESTART IDENTITY CASCADE");
  if (saved === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = saved;
});

describe("argomento agent", () => {
  it("agent_context_no_urls_no_secrets", async () => {
    const texts = await handler("agent").context(userId, String(agentId), null);
    const all = texts.join("\n");
    expect(all).toContain("Prompt iniziale");
    expect(all).toContain("cambia_password");
    for (const bad of ["base-segreta", "interno-segreto", "base_url", "internal_base_url", "SEGRETO", "X-Chiave-App", "hunter2"]) expect(all).not.toContain(bad);
    const ctx = await newCtx("agent", String(agentId));
    const read = JSON.stringify(await call("agent", ctx, "leggi_agente", {}));
    expect(read).not.toContain("base-segreta");
    expect(read).toContain("Prompt iniziale");
    expect(await handler("agent").resolve(userId, String(agentId))).toEqual({ title: "Agente · Cassa" });
    expect(await handler("agent").resolve(userId, "999")).toBeNull();
  });

  it("leggi_strumenti_app_masks_sensitive", async () => {
    const ctx = await newCtx("agent", String(agentId));
    const out = await call("agent", ctx, "leggi_strumenti_app", {});
    expect(out.ok).toBe(true);
    const [tool] = out.result.tools;
    expect(tool.paramsSchema.properties.password).toEqual({ type: "string", "x-sensitive": true });
    expect(tool.paramsSchema.properties.nome).toEqual({ type: "string" });
    const text = JSON.stringify(out);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("SEGRETO-HEADER");
    expect(text).not.toContain("base-segreta");
    const filtered = await call("agent", ctx, "leggi_strumenti_app", { q: "zzz" });
    expect(filtered.result.tools).toHaveLength(0);
  });

  it("agent_tools_only_area_role", async () => {
    const general = await newCtx("agent", String(generalId));
    const bad = await call("agent", general, "proponi_strumenti_agente", { toolIds: [toolId], motivazione: RATIONALE });
    expect(bad).toEqual({ ok: false, error: "l'agente generale usa tutti gli strumenti attivi dell'app" });
    const ctx = await newCtx("agent", String(agentId));
    const ok = await call("agent", ctx, "proponi_strumenti_agente", { toolIds: [toolId, toolId], motivazione: RATIONALE });
    expect(ok.ok).toBe(true);
    const [p] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, ok.result.proposalId));
    expect(p).toMatchObject({ kind: "agent_tools", payload: { toolIds: [toolId] }, rationale: RATIONALE, status: "pending" });
    expect(p!.targetHash).toBe(await subjectHash("agent", String(agentId)));
    const foreign = await call("agent", ctx, "proponi_strumenti_agente", { toolIds: [9999], motivazione: RATIONALE });
    expect(foreign.ok).toBe(false);
  });

  it("proposals_require_rationale", async () => {
    const ctx = await newCtx("agent", String(agentId));
    expect((await call("agent", ctx, "proponi_prompt_agente", { systemPrompt: "Nuovo" })).ok).toBe(false);
    expect((await call("agent", ctx, "proponi_prompt_agente", { systemPrompt: "Nuovo", motivazione: "  " })).ok).toBe(false);
    const ok = await call("agent", ctx, "proponi_prompt_agente", { systemPrompt: "Nuovo", motivazione: RATIONALE });
    expect(ok.ok).toBe(true);
    const [p] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, ok.result.proposalId));
    expect(p).toMatchObject({ kind: "agent_prompt", payload: { systemPrompt: "Nuovo" } });
  });

  it("tool_on_deleted_subject: strumenti ok:false, il turno chiude con risposta normale", async () => {
    const ctx = await newCtx("agent", String(agentId));
    await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
    for (const [name, args] of [["leggi_agente", {}], ["proponi_prompt_agente", { systemPrompt: "x", motivazione: RATIONALE }]] as const) {
      expect(await call("agent", ctx, name, args)).toEqual({ ok: false, error: "argomento eliminato" });
    }
    expect(await subjectHash("agent", String(agentId))).toBeNull();
    // Il turno vero con un argomento sparito è rifiutato a monte (409), non lancia
    const [conv] = await db.select().from(characterConversationsTable).where(eq(characterConversationsTable.id, ctx.conversationId));
    await expect(startCharacterTurn(conv!.id, "Ciao", null)).rejects.toMatchObject({ status: 409, message: "argomento eliminato" });
  });
});

describe("argomento skill", () => {
  it("skill_content_validated_at_proposal", async () => {
    await createSkill({ code: "fatture", name: "Fatture", kind: "casello", content: "Istruzioni" });
    const ctx = await newCtx("skill", "fatture");
    const empty = await call("skill", ctx, "proponi_contenuto_skill", { content: "   ", motivazione: RATIONALE });
    expect(empty).toEqual({ ok: false, error: "il contenuto non può essere vuoto" });
    const ok = await call("skill", ctx, "proponi_contenuto_skill", { content: "Nuove istruzioni", toolHints: ["cambia_password"], motivazione: RATIONALE });
    expect(ok.ok).toBe(true);
    const [p] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, ok.result.proposalId));
    expect(p).toMatchObject({ kind: "skill_content", payload: { content: "Nuove istruzioni", toolHints: ["cambia_password"] } });
    expect(p!.targetHash).toBe(await subjectHash("skill", "fatture"));
    const read = await call("skill", ctx, "leggi_versione_skill", { version: 1 });
    expect(read.result.content).toBe("Istruzioni");
    expect((await call("skill", ctx, "leggi_versione_skill", { version: 7 })).ok).toBe(false);
    expect(await handler("skill").resolve(userId, "fatture")).toEqual({ title: "Skill · fatture" });
  });
});

describe("argomento team_template", () => {
  it("template_roles_shape_checked", async () => {
    const id = await insertTemplateUnchecked({ name: "Squadra", roles: [role()] as never });
    const ctx = await newCtx("team_template", String(id));
    const bad = await call("team_template", ctx, "proponi_ruoli_modello", { roles: [{ key: "Maiuscola!", name: "" }], motivazione: RATIONALE });
    expect(bad.ok).toBe(false);
    expect((await call("team_template", ctx, "proponi_ruoli_modello", { roles: [], motivazione: RATIONALE })).ok).toBe(false);
    const ok = await call("team_template", ctx, "proponi_ruoli_modello", { roles: [role({ name: "Capo nuovo" })], motivazione: RATIONALE });
    expect(ok.ok).toBe(true);
    const [p] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, ok.result.proposalId));
    expect(p).toMatchObject({ kind: "template_roles" });
    expect(p!.targetHash).toBe(await subjectHash("team_template", String(id)));
    const read = await call("team_template", ctx, "leggi_modello", {});
    expect(read.result.roles[0].name).toBe("Capo");
    expect(await handler("team_template").resolve(userId, String(id))).toEqual({ title: "Modello di squadra · Squadra" });
  });

  it("archived_template_resolves_but_rejects_edits", async () => {
    const id = await insertTemplateUnchecked({ name: "Vecchio", roles: [role()] as never });
    const { teamTemplatesTable } = await import("@workspace/db");
    await db.update(teamTemplatesTable).set({ archived: true }).where(eq(teamTemplatesTable.id, id));
    expect(await handler("team_template").resolve(userId, String(id))).not.toBeNull();
    const ctx = await newCtx("team_template", String(id));
    expect(await call("team_template", ctx, "proponi_ruoli_modello", { roles: [role()], motivazione: RATIONALE })).toEqual({ ok: false, error: "modello archiviato" });
  });
});

describe("aree", () => {
  it("area_lists: elenchi con ricerca q, titoli e schede di creazione", async () => {
    await createSkill({ code: "fatture", name: "Fatture", kind: "casello", content: "x" });
    await createSkill({ code: "magazzino", name: "Magazzino", kind: "casello", content: "x" });
    await insertTemplateUnchecked({ name: "Squadra uno", roles: [role()] as never });
    await insertTemplateUnchecked({ name: "Altra", roles: [role()] as never });

    expect(await handler("area_agents").resolve(userId, null)).toEqual({ title: "Area Agenti" });
    expect(await handler("area_skills").resolve(userId, null)).toEqual({ title: "Area Skill" });
    expect(await handler("area_team_templates").resolve(userId, null)).toEqual({ title: "Area Modelli di squadra" });

    const agents = await call("area_agents", await newCtx("area_agents", null), "elenca_agenti", {});
    expect(agents.result.agents.map((a: { name: string }) => a.name).sort()).toEqual(["Cassa", "Generale"]);
    expect((await call("area_agents", await newCtx("area_agents", null), "elenca_agenti", { q: "cass" })).result.agents).toHaveLength(1);

    const skills = await call("area_skills", await newCtx("area_skills", null), "elenca_skill", { q: "magaz" });
    expect(skills.result.skills).toEqual([{ code: "magazzino", name: "Magazzino", kind: "casello", currentVersion: 1, deprecated: false }]);
    const templates = await call("area_team_templates", await newCtx("area_team_templates", null), "elenca_modelli", { q: "uno" });
    expect(templates.result.templates).toMatchObject([{ name: "Squadra uno", roles: 1, version: 1 }]);
    expect((await handler("area_skills").context(userId, null, null))[0]).toContain("fatture");

    // Creazione: schede senza impronta
    const a = await call("area_agents", await newCtx("area_agents", null), "proponi_nuovo_agente", { appId, name: "Nuovo", systemPrompt: "Sei nuovo", toolIds: [toolId], motivazione: RATIONALE });
    const s = await call("area_skills", await newCtx("area_skills", null), "proponi_nuova_skill", { code: "nuova", name: "Nuova", description: "d", kind: "casello", content: "c", motivazione: RATIONALE });
    const t = await call("area_team_templates", await newCtx("area_team_templates", null), "proponi_nuovo_modello", { name: "Nuovo", description: "d", roles: [role()], motivazione: RATIONALE });
    for (const [out, kind] of [[a, "agent_create"], [s, "skill_create"], [t, "template_create"]] as const) {
      expect(out.ok).toBe(true);
      const [p] = await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, out.result.proposalId));
      expect(p).toMatchObject({ kind, targetHash: null });
    }
    const badCode = await call("area_skills", await newCtx("area_skills", null), "proponi_nuova_skill", { code: "X", name: "N", description: "", kind: "casello", content: "c", motivazione: RATIONALE });
    expect(badCode.ok).toBe(false);
    const noApp = await call("area_agents", await newCtx("area_agents", null), "proponi_nuovo_agente", { appId: 999, name: "N", systemPrompt: "p", motivazione: RATIONALE });
    expect(noApp).toEqual({ ok: false, error: "app non trovata" });
  });

  it("area_lists_capped_at_50", async () => {
    for (let i = 0; i < 55; i++) await createSkill({ code: `skill-${String(i).padStart(2, "0")}`, name: `S${i}`, kind: "casello", content: "x" });
    const out = await call("area_skills", await newCtx("area_skills", null), "elenca_skill", {});
    expect(out.result.skills).toHaveLength(50);
    expect(out.result.truncated).toBe(true);
  });
});

describe("subjectHash", () => {
  it("hash_changes_on_edit", async () => {
    await createSkill({ code: "fatture", name: "Fatture", kind: "casello", content: "v1" });
    const id = await insertTemplateUnchecked({ name: "Squadra", roles: [role()] as never });
    const before = {
      agent: await subjectHash("agent", String(agentId)),
      skill: await subjectHash("skill", "fatture"),
      tpl: await subjectHash("team_template", String(id)),
    };
    expect(Object.values(before).every((h) => typeof h === "string" && h.length === 64)).toBe(true);
    expect(await subjectHash("agent", String(agentId))).toBe(before.agent);

    await db.update(agentsTable).set({ systemPrompt: "Cambiato" }).where(eq(agentsTable.id, agentId));
    const afterPrompt = await subjectHash("agent", String(agentId));
    expect(afterPrompt).not.toBe(before.agent);
    await db.insert(agentToolsTable).values({ agentId, toolId });
    expect(await subjectHash("agent", String(agentId))).not.toBe(afterPrompt);

    await updateSkill("fatture", { content: "v2" });
    expect(await subjectHash("skill", "fatture")).not.toBe(before.skill);
    await appendTemplateVersionUnchecked(id, { name: "Squadra", roles: [role({ name: "Altro" })] as never });
    expect(await subjectHash("team_template", String(id))).not.toBe(before.tpl);

    expect(await subjectHash("skill", "assente")).toBeNull();
    expect(await subjectHash("team_template", "9999")).toBeNull();
    expect(await subjectHash("alfred_thread", "1")).toBeNull();
  });
});
