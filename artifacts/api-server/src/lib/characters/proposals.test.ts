import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentToolsTable,
  agentsTable,
  appToolsTable,
  agentTriggersTable,
  appsTable,
  characterConversationsTable,
  characterMessagesTable,
  characterProposalsTable,
  pendingActionsTable,
  pendingActionStepsTable,
  skillVersionsTable,
  skillsTable,
  teamTemplateVersionsTable,
  teamTemplatesTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { encryptSecret } from "../secrets";
import { enqueueAction } from "../actions/queue";
import { queueTestProposal } from "../../../test/proposal-fixture";
import { rejectAction } from "../actions/decide";
import { consumeActionDecision } from "../../middlewares/rate-limit";
import { createSkill, getSkill, updateSkill } from "../teams/skills";
import { getTemplate, insertTemplateUnchecked } from "../teams/templates";
import type { CatalogTool } from "../tools/types";
import type { TemplateRole } from "../teams/manifest";
import { startFakeMcp, type FakeMcp } from "../../../test/fake-mcp";
import { allowTestLoopback } from "../../../test/fake-provider";
import { subjectHash } from "./subjects/hash";
import { decideCharacterProposal } from "./proposals";
import type { Character, ProposalKind, SubjectType } from "./types";

// Gli utenti non ripartono da 1 (TRUNCATE senza RESTART IDENTITY): il limite delle decisioni sulla coda è in memoria
// per id utente, così ogni test ha un contatore nuovo.

const SCHEMA = { type: "object", properties: { id: { type: "string" } } };

let restoreLoopback: () => void;
let mcp: FakeMcp;
let userId: number;
let otherUserId: number;
let appId: number;
let agentId: number;
let toolA: number;
let toolB: number;
let mcpTool: CatalogTool;
let userTool: CatalogTool;
let templateId: number;

const role = (over: Partial<TemplateRole> = {}): TemplateRole => ({ key: "capo", name: "Capo", task: "Guida", isLead: true, runsOn: "node", aiModelId: null, tools: [], skills: [], ...over });

async function conversation(character: Character, subjectType: SubjectType, subjectId: string | null, owner = userId) {
  const [conv] = await db
    .insert(characterConversationsTable)
    .values({ userId: owner, character, subjectType, subjectId, subjectTitle: "t", title: "" })
    .returning();
  const [msg] = await db.insert(characterMessagesTable).values({ conversationId: conv!.id, role: "assistant", content: "" }).returning();
  return { conversationId: conv!.id, messageId: msg!.id };
}

/** Scheda di Lucius sull'argomento, con l'impronta attuale dell'oggetto per le schede di modifica. */
async function lucius(subjectType: SubjectType, subjectId: string | null, kind: ProposalKind, payload: unknown, owner = userId): Promise<number> {
  const { conversationId, messageId } = await conversation("lucius", subjectType, subjectId, owner);
  const targetHash = subjectId === null ? null : await subjectHash(subjectType, subjectId);
  const [row] = await db
    .insert(characterProposalsTable)
    .values({ conversationId, messageId, kind, payload, rationale: "serve", targetHash })
    .returning();
  return row!.id;
}

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

/** Scheda `decision` di Alfred su una voce della coda, come la crea `proponi_decisione`. */
async function alfredDecision(number: number, decision: "approva" | "rifiuta", note: string | null = null, exclude: string[] | null = null): Promise<number> {
  const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, number));
  const { conversationId, messageId } = await conversation("alfred", "alfred_thread", null);
  const payload = { number, decision, note, kind: item!.kind, teamName: null, summary: item!.summary, needsUserToken: false, exclude };
  const [row] = await db
    .insert(characterProposalsTable)
    .values({ conversationId, messageId, kind: "decision", payload, rationale: "", targetHash: sha256(`pending\n${item!.summary}`) })
    .returning();
  return row!.id;
}

async function enqueue(tool: CatalogTool = mcpTool): Promise<number> {
  const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args: { id: "42" }, recipient: "Rosa", summary: "Aggiorna la scheda di Rosa" });
  if (!out.ok) throw new Error(out.message);
  return out.number;
}

const status = async (id: number) => (await db.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, id)))[0]!.status;

beforeAll(async () => {
  process.env["CASELLO_SECRET_KEY"] ??= "a".repeat(64);
  restoreLoopback = allowTestLoopback();
  mcp = await startFakeMcp({ tools: [{ name: "aggiorna", text: "fatto" }] });
});

afterAll(async () => {
  await mcp.close();
  restoreLoopback();
  await pool.query("TRUNCATE apps, users, skills, team_templates CASCADE");
});

beforeEach(async () => {
  mcp.calls.length = 0;
  await pool.query("TRUNCATE apps, ai_accounts, users, skills, team_templates CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "a@x.it", name: "A" }).returning();
  userId = u!.id;
  const [o] = await db.insert(usersTable).values({ email: "b@x.it", name: "B" }).returning();
  otherUserId = o!.id;
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example", mcpUrl: mcp.url, serviceAuth: { header: "X-Key", scheme: null }, serviceSecretEnc: encryptSecret("s") })
    .returning();
  appId = app!.id;
  const [ag] = await db.insert(agentsTable).values({ appId, name: "Cassa", role: "area", systemPrompt: "Prompt iniziale" }).returning();
  agentId = ag!.id;
  const httpTool = (name: string) =>
    ({ appId, name, kind: "http", identity: "service", level: "L0", status: "active", paramsSchema: SCHEMA, definition: { method: "GET", path: "/x", paramLocations: {} } }) as InsertAppTool;
  const [a, b] = await db.insert(appToolsTable).values([httpTool("leggi_a"), httpTool("leggi_b")]).returning();
  toolA = a!.id;
  toolB = b!.id;
  const [m] = await db
    .insert(appToolsTable)
    .values({ appId, name: "aggiorna", kind: "mcp", identity: "service", level: "L2", status: "active", paramsSchema: SCHEMA, definition: { mcpName: "aggiorna" } } as InsertAppTool)
    .returning();
  mcpTool = { ...m!, paramsSchema: SCHEMA, definition: m!.definition as CatalogTool["definition"] };
  const [ut] = await db
    .insert(appToolsTable)
    .values({ appId, name: "cambia_password", kind: "mcp", identity: "user", level: "L2", status: "active", paramsSchema: SCHEMA, definition: { mcpName: "aggiorna" } } as InsertAppTool)
    .returning();
  userTool = { ...ut!, paramsSchema: SCHEMA, definition: ut!.definition as CatalogTool["definition"] };
  await createSkill({ code: "scrittura", name: "Scrittura", kind: "casello", content: "Scrivi bene." });
  templateId = await insertTemplateUnchecked({ name: "Squadra base", roles: [role()] });
});

describe("accettare applica e marca accepted", () => {
  it("accept_agent_prompt", async () => {
    const id = await lucius("agent", String(agentId), "agent_prompt", { systemPrompt: "Prompt nuovo" });
    const view = await decideCharacterProposal(userId, id, "accept");
    expect(view.status).toBe("accepted");
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    expect(agent!.systemPrompt).toBe("Prompt nuovo");
  });

  it("accept_agent_tools", async () => {
    const id = await lucius("agent", String(agentId), "agent_tools", { toolIds: [toolB, toolA] });
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const links = await db.select().from(agentToolsTable).where(eq(agentToolsTable.agentId, agentId));
    expect(links.map((l) => l.toolId).sort((x, y) => x - y)).toEqual([toolA, toolB]);
  });

  it("accept_skill_content_new_version", async () => {
    const id = await lucius("skill", "scrittura", "skill_content", { content: "Scrivi meglio.", toolHints: ["leggi_a"] });
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const skill = await getSkill("scrittura");
    expect(skill).toMatchObject({ currentVersion: 2, content: "Scrivi meglio.", toolHints: ["leggi_a"] });
  });

  it("accept_template_roles_new_version", async () => {
    const roles = [role(), role({ key: "dev", name: "Sviluppatore", task: "Sviluppa", isLead: false, skills: ["scrittura"] })];
    const id = await lucius("team_template", String(templateId), "template_roles", { roles });
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const tpl = await getTemplate(templateId);
    expect(tpl.version).toBe(2);
    expect(tpl.name).toBe("Squadra base");
    expect(tpl.roles.map((r) => r.key)).toEqual(["capo", "dev"]);
  });

  it("accept_agent_create_draft", async () => {
    const id = await lucius("area_agents", null, "agent_create", { appId, name: "Magazzino", systemPrompt: "Gestisci il magazzino", toolIds: [toolA] });
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const [created] = await db.select().from(agentsTable).where(eq(agentsTable.name, "Magazzino"));
    expect(created).toMatchObject({ appId, role: "area", status: "draft", systemPrompt: "Gestisci il magazzino", aiModelId: null });
    const links = await db.select().from(agentToolsTable).where(eq(agentToolsTable.agentId, created!.id));
    expect(links.map((l) => l.toolId)).toEqual([toolA]);
  });

  it("accept_agent_trigger_create_paused", async () => {
    const payload = { agentId, name: "Nuove email", toolId: toolA, args: { id: "1" }, itemsPath: "items", idField: "id", intervalSeconds: 300 };
    const id = await lucius("agent", String(agentId), "agent_trigger_create", payload);
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const [t] = await db.select().from(agentTriggersTable).where(eq(agentTriggersTable.agentId, agentId));
    expect(t).toMatchObject({ kind: "poll", status: "paused", createdBy: userId, name: "Nuove email", toolId: toolA });
  });

  it("accept_agent_trigger_create_rule_error_keeps_pending", async () => {
    const id = await lucius("agent", String(agentId), "agent_trigger_create", { agentId, name: "Scrive", toolId: mcpTool.id, itemsPath: "items", idField: "id" });
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({ status: 400, message: "lo strumento non può essere usato da un innesco" });
    expect(await status(id)).toBe("pending");
    expect(await db.select().from(agentTriggersTable)).toHaveLength(0);
  });

  it("accept_skill_create", async () => {
    const id = await lucius("area_skills", null, "skill_create", { code: "revisione", name: "Revisione", description: "Rilegge", kind: "casello", content: "Rileggi tutto." });
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    expect(await getSkill("revisione")).toMatchObject({ currentVersion: 1, content: "Rileggi tutto.", description: "Rilegge" });
  });

  it("accept_template_create", async () => {
    const id = await lucius("area_team_templates", null, "template_create", { name: "Squadra nuova", description: "Per i rilasci", roles: [role()] });
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const [tpl] = await db.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.name, "Squadra nuova"));
    expect(tpl).toMatchObject({ description: "Per i rilasci", version: 1 });
  });
});

describe("impronta, regole, concorrenza", () => {
  it("stale_when_hash_changed", async () => {
    const id = await lucius("skill", "scrittura", "skill_content", { content: "Scrivi meglio." });
    await updateSkill("scrittura", { content: "Cambiata dall'editor." });
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({
      status: 409,
      message: "l'oggetto è cambiato: chiedi a Lucius una proposta aggiornata",
    });
    expect(await status(id)).toBe("stale");
    expect((await getSkill("scrittura")).content).toBe("Cambiata dall'editor.");
    // Anche un oggetto sparito rende la scheda stale
    const gone = await lucius("agent", String(agentId), "agent_prompt", { systemPrompt: "x" });
    await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
    await expect(decideCharacterProposal(userId, gone, "accept")).rejects.toMatchObject({ status: 409 });
    expect(await status(gone)).toBe("stale");
  });

  it("rule_error_keeps_pending", async () => {
    const id = await lucius("team_template", String(templateId), "template_roles", { roles: [role({ isLead: false })] });
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({ status: 400, message: "una squadra ha esattamente un capo" });
    expect(await status(id)).toBe("pending");
    expect((await getTemplate(templateId)).version).toBe(1);
    // Nome già usato su una creazione: 409 di regola, la scheda resta pending
    const dup = await lucius("area_team_templates", null, "template_create", { name: "Squadra base", description: "", roles: [role()] });
    await expect(decideCharacterProposal(userId, dup, "accept")).rejects.toMatchObject({ status: 409, message: "nome già usato" });
    expect(await status(dup)).toBe("pending");
  });

  it("concurrent_accept_one_wins", async () => {
    const id = await lucius("skill", "scrittura", "skill_content", { content: "Scrivi meglio." });
    const results = await Promise.allSettled([decideCharacterProposal(userId, id, "accept"), decideCharacterProposal(userId, id, "accept")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect(ko[0]!.reason).toMatchObject({ status: 409, message: "scheda già decisa" });
    const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.code, "scrittura"));
    const versions = await db.select().from(skillVersionsTable).where(eq(skillVersionsTable.skillId, skill!.id));
    expect(versions).toHaveLength(2);
  });

  it("reject_has_no_effect", async () => {
    const id = await lucius("agent", String(agentId), "agent_prompt", { systemPrompt: "Prompt nuovo" });
    expect((await decideCharacterProposal(userId, id, "reject")).status).toBe("rejected");
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    expect(agent!.systemPrompt).toBe("Prompt iniziale");
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({ status: 409, message: "scheda già decisa" });
    const n = await enqueue();
    const card = await alfredDecision(n, "approva");
    expect((await decideCharacterProposal(userId, card, "reject")).status).toBe("rejected");
    expect((await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n)))[0]!.status).toBe("pending");
    expect(mcp.calls).toHaveLength(0);
    expect(await db.select().from(teamTemplateVersionsTable)).toHaveLength(1);
  });

  it("foreign_proposal_404", async () => {
    const id = await lucius("agent", String(agentId), "agent_prompt", { systemPrompt: "x" });
    await expect(decideCharacterProposal(otherUserId, id, "accept")).rejects.toMatchObject({ status: 404, message: "scheda non trovata" });
    await expect(decideCharacterProposal(otherUserId, id, "reject")).rejects.toMatchObject({ status: 404 });
    await expect(decideCharacterProposal(userId, 999_999, "accept")).rejects.toMatchObject({ status: 404 });
    expect(await status(id)).toBe("pending");
  });

  it("handoff: accettare la marca accepted senza effetti", async () => {
    const { conversationId, messageId } = await conversation("alfred", "alfred_thread", null);
    const [row] = await db
      .insert(characterProposalsTable)
      .values({ conversationId, messageId, kind: "handoff", payload: { to: "lucius", subjectType: "agent", subjectId: String(agentId), question: "?" }, rationale: "" })
      .returning();
    expect((await decideCharacterProposal(userId, row!.id, "accept")).status).toBe("accepted");
  });
});

describe("conversazione archiviata", () => {
  it("archived_conversation_409: accettare e rifiutare, anche la scheda decision, senza effetti né limite consumato", async () => {
    const n = await enqueue();
    const decisionId = await alfredDecision(n, "rifiuta");
    const luciusId = await lucius("agent", String(agentId), "agent_prompt", { systemPrompt: "nuovo" });
    const handoffId = await lucius("agent", String(agentId), "handoff", { to: "alfred", question: "?" });
    await db.update(characterConversationsTable).set({ archivedAt: new Date() });
    for (let i = 0; i < 20; i++) expect(consumeActionDecision(userId)).toBe(true);
    for (const id of [decisionId, luciusId, handoffId]) {
      for (const d of ["accept", "reject"] as const) {
        await expect(decideCharacterProposal(userId, id, d)).rejects.toMatchObject({ status: 409, message: "conversazione archiviata" });
      }
      expect(await status(id)).toBe("pending");
    }
    expect((await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n)))[0]!.status).toBe("pending");
    const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
    expect(agent!.systemPrompt).not.toBe("nuovo");
  });
});

describe("scheda decision di Alfred", () => {
  it("decision_approve", async () => {
    const n = await enqueue();
    const id = await alfredDecision(n, "approva");
    const view = await decideCharacterProposal(userId, id, "accept");
    expect(view.status).toBe("accepted");
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n));
    expect(item!.status).toBe("done");
    expect(mcp.calls).toHaveLength(1);
  });

  it("decision_reject_with_note", async () => {
    const n = await enqueue();
    const id = await alfredDecision(n, "rifiuta", "Non adesso");
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n));
    expect(item).toMatchObject({ status: "rejected", decisionNote: "Non adesso" });
    expect(mcp.calls).toHaveLength(0);
  });

  it("decision_stale_when_decided_elsewhere", async () => {
    const n = await enqueue();
    const id = await alfredDecision(n, "approva");
    expect((await rejectAction(userId, n, "dalla coda")).ok).toBe(true);
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({ status: 409, message: "la voce è cambiata: ricarica la coda" });
    expect(await status(id)).toBe("stale");
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n));
    expect(item).toMatchObject({ status: "rejected", decisionNote: "dalla coda" });
    expect(mcp.calls).toHaveLength(0);
  });

  it("decision_user_token_refused", async () => {
    const n = await enqueue(userTool);
    const id = await alfredDecision(n, "approva");
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({ status: 409, message: "questa voce si approva dalla pagina Da confermare" });
    expect(await status(id)).toBe("pending");
    expect((await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n)))[0]!.status).toBe("pending");
  });

  it("decision_proposal_with_exclude: accettare approva la proposta escludendo i passi della scheda", async () => {
    const n = await queueTestProposal({ userId, appId, toolId: mcpTool.id, toolName: "aggiorna" });
    const id = await alfredDecision(n, "approva", null, ["p3"]);
    expect((await decideCharacterProposal(userId, id, "accept")).status).toBe("accepted");
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n));
    expect(item!.status).toBe("done");
    const steps = await db.select().from(pendingActionStepsTable).where(eq(pendingActionStepsTable.pendingActionId, item!.id));
    expect(Object.fromEntries(steps.map((s) => [s.key, s.status]))).toEqual({ p1: "done", p2: "done", p3: "excluded" });
    expect(mcp.calls).toHaveLength(2);
  });

  it("decision_rate_limited", async () => {
    const n = await enqueue();
    const id = await alfredDecision(n, "rifiuta");
    for (let i = 0; i < 20; i++) expect(consumeActionDecision(userId)).toBe(true);
    await expect(decideCharacterProposal(userId, id, "accept")).rejects.toMatchObject({ status: 429, message: "Troppe richieste: riprova tra poco" });
    expect(await status(id)).toBe("pending");
    expect((await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n)))[0]!.status).toBe("pending");
  });
});
