// Argomenti generali di Lucius (`area_agents`, `area_skills`, `area_team_templates`): un elenco con ricerca (al massimo 50
// voci) e lo strumento di creazione dell'area. Alla proposta si controllano solo forma e limiti; nome o codice già usati
// (409) e il resto delle regole li dà l'accettazione. Schede di creazione: nessuna impronta (`target_hash` null).

import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db, agentsTable, appToolsTable, appsTable } from "@workspace/db";
import type { ChatToolCall } from "../../ai/chat-types";
import { codeAvailability } from "../../code-reader/source-cache";
import { MAX_SKILL_CONTENT, SKILL_CODE, listSkills, validateSkillContent } from "../../teams/skills";
import { listTemplates } from "../../teams/templates";
import { recordProposal } from "../proposals";
import { toolFail, toolOk, type ProposalKind, type SubjectHandler, type TurnContext } from "../types";
import { MAX_AGENT_PROMPT } from "./agent";
import {
  LIST_MAX, LUCIUS_MESSAGES, READ_APP_TOOLS_TOOL, RATIONALE_PROP, ReadAppToolsArgs, checkRoles, fn, likePattern, parseArgs, positive,
  rationaleSchema, readAppToolsTool,
} from "./shared";

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;
const Q = { q: { type: "string", description: "Testo da cercare nel nome" } };
const SearchArgs = z.object({ q: z.string().max(100).optional() });

// --- Agenti ------------------------------------------------------------------------------------------

async function listAgents(q?: string) {
  const conditions = q?.trim() ? [or(ilike(agentsTable.name, likePattern(q)), ilike(appsTable.name, likePattern(q)))] : [];
  const rows = await db
    .select({ id: agentsTable.id, name: agentsTable.name, role: agentsTable.role, status: agentsTable.status, appId: appsTable.id, app: appsTable.name })
    .from(agentsTable)
    .innerJoin(appsTable, eq(appsTable.id, agentsTable.appId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(appsTable.name), asc(agentsTable.name))
    .limit(LIST_MAX + 1);
  return { agents: rows.slice(0, LIST_MAX), truncated: rows.length > LIST_MAX };
}

const AREA_AGENTS_TOOLS = [
  fn("elenca_agenti", "Elenca gli agenti (nome, app, ruolo, stato), al massimo 50, con ricerca per nome dell'agente o dell'app.", Q),
  READ_APP_TOOLS_TOOL,
  fn(
    "proponi_nuovo_agente",
    "Propone un agente nuovo per un'app (nasce in bozza). Non crea nulla: l'utente vede la scheda e decide.",
    {
      appId: { type: "integer", description: "Id dell'app" },
      name: { type: "string", description: "Nome dell'agente" },
      systemPrompt: { type: "string", description: `Prompt di sistema, al massimo ${MAX_AGENT_PROMPT} caratteri` },
      toolIds: { type: "array", items: { type: "integer" }, description: "Strumenti dell'app da collegare (facoltativo)" },
      motivazione: RATIONALE_PROP,
    },
    ["appId", "name", "systemPrompt", "motivazione"],
  ),
];

const NewAgentArgs = z.object({
  appId: positive,
  name: z.string().trim().min(1).max(NAME_MAX),
  systemPrompt: z.string().min(1).max(MAX_AGENT_PROMPT),
  toolIds: z.array(positive).max(500).optional(),
  motivazione: z.unknown(),
});

async function proposeAgent(ctx: TurnContext, a: z.infer<typeof NewAgentArgs>, rationale: string): Promise<string> {
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, a.appId)).limit(1);
  if (!app) return toolFail(LUCIUS_MESSAGES.appNotFound);
  const toolIds = a.toolIds === undefined ? undefined : [...new Set(a.toolIds)];
  if (toolIds && toolIds.length > 0) {
    const owned = await db.select({ id: appToolsTable.id }).from(appToolsTable).where(and(eq(appToolsTable.appId, a.appId), inArray(appToolsTable.id, toolIds)));
    if (owned.length !== toolIds.length) return toolFail("alcuni strumenti non esistono o non appartengono all'app");
  }
  const payload = { appId: a.appId, name: a.name, systemPrompt: a.systemPrompt, ...(toolIds === undefined ? {} : { toolIds }) };
  return finish(ctx, "agent_create", payload, rationale);
}

// --- Skill -------------------------------------------------------------------------------------------

async function listSkillRows(q?: string) {
  const all = await listSkills(q?.trim() ? { q } : {});
  return {
    skills: all.slice(0, LIST_MAX).map((s) => ({ code: s.code, name: s.name, kind: s.kind, currentVersion: s.currentVersion, deprecated: s.deprecated })),
    truncated: all.length > LIST_MAX,
  };
}

const AREA_SKILLS_TOOLS = [
  fn("elenca_skill", "Elenca le skill del catalogo (codice, tipo, versione, deprecata), al massimo 50, con ricerca per codice o nome.", Q),
  fn(
    "proponi_nuova_skill",
    "Propone una skill nuova per il catalogo. Non crea nulla: l'utente vede la scheda e decide.",
    {
      code: { type: "string", description: "Codice unico: minuscole, cifre, '.', '_' e '-', da 2 a 64 caratteri" },
      name: { type: "string", description: "Nome" },
      description: { type: "string", description: "Descrizione breve" },
      kind: { type: "string", enum: ["casello", "node"], description: "casello: istruzioni; node: nome della skill sul nodo" },
      content: { type: "string", description: `Istruzioni (al massimo ${MAX_SKILL_CONTENT} caratteri) o nome della skill sul nodo` },
      motivazione: RATIONALE_PROP,
    },
    ["code", "name", "description", "kind", "content", "motivazione"],
  ),
];

const NewSkillArgs = z.object({
  code: z.string(),
  name: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().max(DESCRIPTION_MAX),
  kind: z.enum(["casello", "node"]),
  content: z.string(),
  motivazione: z.unknown(),
});

async function proposeSkill(ctx: TurnContext, a: z.infer<typeof NewSkillArgs>, rationale: string): Promise<string> {
  if (!SKILL_CODE.test(a.code)) return toolFail("codice non valido: da 2 a 64 caratteri tra minuscole, cifre, '.', '_' e '-', iniziando da una lettera o cifra");
  const error = validateSkillContent(a.kind, a.content);
  if (error) return toolFail(error);
  return finish(ctx, "skill_create", { code: a.code, name: a.name, description: a.description, kind: a.kind, content: a.content }, rationale);
}

// --- Modelli di squadra ------------------------------------------------------------------------------

async function listTemplateRows(q?: string) {
  const needle = q?.trim().toLowerCase();
  const all = (await listTemplates({ archived: false })).filter((t) => !needle || t.name.toLowerCase().includes(needle));
  return {
    templates: all.slice(0, LIST_MAX).map((t) => ({ id: t.id, name: t.name, roles: t.roles.length, version: t.version })),
    truncated: all.length > LIST_MAX,
  };
}

const AREA_TEMPLATES_TOOLS = [
  fn("elenca_modelli", "Elenca i modelli di squadra non archiviati (nome, numero di ruoli, versione), al massimo 50, con ricerca per nome.", Q),
  fn(
    "proponi_nuovo_modello",
    "Propone un modello di squadra nuovo. Ogni ruolo: key, name, task (identità), isLead, runsOn cloud|node, aiModelId (null per node), tools (id), skills (codici). Un solo capo. Non crea nulla: l'utente vede la scheda e decide.",
    {
      name: { type: "string", description: "Nome del modello" },
      description: { type: "string", description: "Descrizione" },
      roles: { type: "array", items: { type: "object" }, description: "I ruoli, nel formato del manifesto del modello" },
      motivazione: RATIONALE_PROP,
    },
    ["name", "roles", "motivazione"],
  ),
];

const NewTemplateArgs = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().max(DESCRIPTION_MAX).optional(),
  roles: z.unknown(),
  motivazione: z.unknown(),
});

async function proposeTemplate(ctx: TurnContext, a: z.infer<typeof NewTemplateArgs>, rationale: string): Promise<string> {
  const checked = checkRoles(a.roles);
  if (!checked.ok) return toolFail(checked.error);
  return finish(ctx, "template_create", { name: a.name, description: a.description ?? "", roles: checked.roles }, rationale);
}

// --- Comune ------------------------------------------------------------------------------------------

async function finish(ctx: TurnContext, kind: ProposalKind, payload: unknown, rationale: string): Promise<string> {
  const out = await recordProposal(ctx, kind, payload, rationale, null);
  if ("error" in out) return toolFail(out.error);
  return toolOk({ proposalId: out.id, kind });
}

type AreaTool = { schema: z.ZodType; run: (a: any, ctx: TurnContext) => Promise<string> };

/** Strumenti di creazione: la motivazione si controlla prima della validazione del resto. */
const creator = (schema: z.ZodType, propose: (ctx: TurnContext, a: any, rationale: string) => Promise<string>): AreaTool => ({
  schema,
  run: async (a, ctx) => {
    const rationale = rationaleSchema.safeParse(a.motivazione);
    if (!rationale.success) return toolFail(LUCIUS_MESSAGES.rationale);
    return propose(ctx, a, rationale.data);
  },
});

const area = (type: "area_agents" | "area_skills" | "area_team_templates", title: string, tools: ReturnType<typeof fn>[], handlers: Record<string, AreaTool>, list: (q?: string) => Promise<unknown>, extra: Partial<SubjectHandler> = {}): SubjectHandler => ({
  character: "lucius",
  type,
  resolve: async () => ({ title }),
  context: async () => [JSON.stringify(await list())],
  tools,
  runTool: async (call: ChatToolCall, ctx: TurnContext) => {
    const h = Object.hasOwn(handlers, call.name) ? handlers[call.name] : undefined;
    if (!h) return toolFail(LUCIUS_MESSAGES.unknownTool);
    const parsed = h.schema.safeParse(parseArgs(call.arguments));
    if (!parsed.success) return toolFail(LUCIUS_MESSAGES.badArgs);
    try {
      return await h.run(parsed.data, ctx);
    } catch {
      return toolFail(LUCIUS_MESSAGES.internal);
    }
  },
  ...extra,
});

const listTool = (list: (q?: string) => Promise<unknown>): AreaTool => ({ schema: SearchArgs, run: async (a) => toolOk(await list(a.q)) });

export const areaAgentsSubject = area("area_agents", "Area Agenti", AREA_AGENTS_TOOLS, {
  elenca_agenti: listTool(listAgents),
  leggi_strumenti_app: { schema: ReadAppToolsArgs, run: (a) => readAppToolsTool(a, null) },
  proponi_nuovo_agente: creator(NewAgentArgs, proposeAgent),
}, listAgents, {
  // Nessuna app di partenza: gli strumenti del codice vogliono `app`; disponibili se almeno un'app ha il codice leggibile
  codeApp: async (userId) => {
    for (const app of await db.select().from(appsTable).orderBy(asc(appsTable.id))) {
      if ((await codeAvailability(userId, app)).ok) return { defaultAppId: null, available: true };
    }
    return { defaultAppId: null, available: false };
  },
});

export const areaSkillsSubject = area("area_skills", "Area Skill", AREA_SKILLS_TOOLS, {
  elenca_skill: listTool(listSkillRows),
  proponi_nuova_skill: creator(NewSkillArgs, proposeSkill),
}, listSkillRows);

export const areaTemplatesSubject = area("area_team_templates", "Area Modelli di squadra", AREA_TEMPLATES_TOOLS, {
  elenca_modelli: listTool(listTemplateRows),
  proponi_nuovo_modello: creator(NewTemplateArgs, proposeTemplate),
}, listTemplateRows);
