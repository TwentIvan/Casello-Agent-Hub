// Argomento `agent` di Lucius: un agente di un'app. Strumenti di lettura (agente, catalogo dei tool dell'app, skill) e due
// proposte: il prompt di sistema (`agent_prompt`) e i tool collegati (`agent_tools`, solo agenti di ruolo `area`).
// Alla proposta si controllano solo forma e limiti; la validazione completa è dell'accettazione. Mai indirizzi né segreti.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, agentToolsTable, agentsTable, aiModelsTable, appToolsTable, appsTable } from "@workspace/db";
import type { ChatToolCall } from "../../ai/chat-types";
import { codeAvailability } from "../../code-reader/source-cache";
import { effectiveLevel } from "../../tools/levels";
import { validateTriggerConfig } from "../../triggers/config";
import { recordProposal } from "../proposals";
import { CHARACTER_MESSAGES, toolFail, toolOk, type SubjectHandler, type TurnContext } from "../types";
import { subjectHash } from "./hash";
import {
  LUCIUS_MESSAGES, READ_APP_TOOLS_TOOL, READ_SKILL_TOOL, RATIONALE_PROP, ReadAppToolsArgs, ReadSkillArgs, appToolsView, fn,
  idFromSubject, parseArgs, positive, rationaleSchema, readAppToolsTool, readSkillTool,
} from "./shared";

export const MAX_AGENT_PROMPT = 20_000;
export const AGENT_MESSAGES = {
  generalAllTools: "l'agente generale usa tutti gli strumenti attivi dell'app",
  toolsNotOfApp: "alcuni strumenti non esistono o non appartengono all'app dell'agente",
  promptTooLong: `il prompt supera ${MAX_AGENT_PROMPT} caratteri`,
} as const;

export const AGENT_TOOLS = [
  fn("leggi_agente", "Rilegge l'agente: prompt, ruolo, stato, modello e strumenti collegati.", {}),
  READ_APP_TOOLS_TOOL,
  READ_SKILL_TOOL,
  fn(
    "proponi_prompt_agente",
    "Propone un nuovo prompt di sistema per l'agente. Non applica nulla: l'utente vede la scheda e decide.",
    { systemPrompt: { type: "string", description: `Il prompt completo, al massimo ${MAX_AGENT_PROMPT} caratteri.` }, motivazione: RATIONALE_PROP },
    ["systemPrompt", "motivazione"],
  ),
  fn(
    "proponi_strumenti_agente",
    "Propone l'elenco completo degli strumenti collegati a un agente di area (sostituisce quello attuale). Non vale per l'agente generale.",
    { toolIds: { type: "array", items: { type: "integer" }, description: "Id degli strumenti dell'app dell'agente" }, motivazione: RATIONALE_PROP },
    ["toolIds", "motivazione"],
  ),
  fn(
    "proponi_innesco",
    "Propone un innesco di sorveglianza (polling) per l'agente: ogni tanto chiama un tool di lettura dell'app e avvia una run per ogni elemento nuovo. Nasce in pausa: l'utente lo prova e lo attiva. Lo schema del tool si legge con `leggi_strumenti_app`; non viene mai chiamato da te. Non applica nulla: l'utente vede la scheda e decide.",
    {
      name: { type: "string", description: "Nome dell'innesco, 1..80 caratteri" },
      instructions: { type: "string", description: "Istruzioni per l'agente a ogni elemento nuovo, al massimo 2 000 caratteri" },
      toolId: { type: "integer", description: "Id di un tool di lettura (L0) dell'app" },
      args: { type: "object", description: "Argomenti fissi del tool, secondo il suo schema" },
      itemsPath: { type: "string", description: "Percorso con punti dell'elenco di elementi nella risposta (vuoto: la risposta stessa)" },
      idField: { type: "string", description: "Campo con l'identificatore dell'elemento" },
      versionField: { type: "string", description: "Campo la cui variazione rende nuovo un elemento già visto" },
      cursorParam: { type: "string", description: "Parametro del tool in cui passare il cursore" },
      cursorField: { type: "string", description: "Campo dell'elemento da cui ricavare il cursore" },
      filter: {
        type: "object",
        description: "Considera solo gli elementi in cui `field` è uguale a `equals`",
        properties: { field: { type: "string" }, equals: { type: ["string", "number", "boolean"] } },
        required: ["field", "equals"],
      },
      intervalSeconds: { type: "integer", description: "Intervallo tra due letture, da 60 a 86400 secondi (default 300)" },
      motivazione: RATIONALE_PROP,
    },
    ["name", "toolId", "idField", "motivazione"],
  ),
];

const TriggerArgs = z.object({
  name: z.string(),
  instructions: z.string().nullish(),
  toolId: positive,
  args: z.record(z.string(), z.unknown()).nullish(),
  itemsPath: z.string().nullish(),
  idField: z.string().min(1),
  versionField: z.string().nullish(),
  cursorParam: z.string().nullish(),
  cursorField: z.string().nullish(),
  filter: z.object({ field: z.string(), equals: z.union([z.string(), z.number(), z.boolean()]) }).nullish(),
  intervalSeconds: z.number().int().nullish(),
  motivazione: z.unknown(),
});

const SCHEMAS = {
  leggi_agente: z.object({}).passthrough(),
  leggi_strumenti_app: ReadAppToolsArgs,
  leggi_skill: ReadSkillArgs,
  proponi_prompt_agente: z.object({ systemPrompt: z.string().min(1), motivazione: z.unknown() }),
  proponi_strumenti_agente: z.object({ toolIds: z.array(positive).max(500), motivazione: z.unknown() }),
  proponi_innesco: TriggerArgs,
} as const;
type ToolName = keyof typeof SCHEMAS;
const isToolName = (name: string): name is ToolName => Object.hasOwn(SCHEMAS, name);

async function loadAgent(id: number) {
  const [row] = await db
    .select({ agent: agentsTable, appName: appsTable.name, modelName: aiModelsTable.displayName })
    .from(agentsTable)
    .innerJoin(appsTable, eq(appsTable.id, agentsTable.appId))
    .leftJoin(aiModelsTable, eq(aiModelsTable.id, agentsTable.aiModelId))
    .where(eq(agentsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function agentView(id: number) {
  const row = await loadAgent(id);
  if (!row) return null;
  const a = row.agent;
  const linked = await db
    .select({ tool: appToolsTable })
    .from(agentToolsTable)
    .innerJoin(appToolsTable, eq(appToolsTable.id, agentToolsTable.toolId))
    .where(eq(agentToolsTable.agentId, id));
  return {
    id: a.id,
    name: a.name,
    appId: a.appId,
    app: row.appName,
    role: a.role,
    area: a.area,
    status: a.status,
    model: row.modelName,
    systemPrompt: a.systemPrompt,
    tools:
      a.role === "general"
        ? "tutti gli strumenti attivi dell'app"
        : linked.map(({ tool }) => ({ id: tool.id, name: tool.name, level: effectiveLevel(tool), status: tool.status })).sort((x, y) => x.id - y.id),
  };
}

async function propose(ctx: TurnContext, id: number, name: "proponi_prompt_agente" | "proponi_strumenti_agente", a: Record<string, unknown>): Promise<string> {
  const rationale = rationaleSchema.safeParse(a["motivazione"]);
  if (!rationale.success) return toolFail(LUCIUS_MESSAGES.rationale);
  const row = await loadAgent(id);
  if (!row) return toolFail(CHARACTER_MESSAGES.subjectGone);
  let kind: "agent_prompt" | "agent_tools";
  let payload: unknown;
  if (name === "proponi_prompt_agente") {
    if ((a["systemPrompt"] as string).length > MAX_AGENT_PROMPT) return toolFail(AGENT_MESSAGES.promptTooLong);
    kind = "agent_prompt";
    payload = { systemPrompt: a["systemPrompt"] };
  } else {
    if (row.agent.role === "general") return toolFail(AGENT_MESSAGES.generalAllTools);
    const toolIds = [...new Set(a["toolIds"] as number[])];
    if (toolIds.length > 0) {
      const owned = await db.select({ id: appToolsTable.id }).from(appToolsTable).where(eq(appToolsTable.appId, row.agent.appId));
      const ownedIds = new Set(owned.map((t) => t.id));
      if (!toolIds.every((t) => ownedIds.has(t))) return toolFail(AGENT_MESSAGES.toolsNotOfApp);
    }
    kind = "agent_tools";
    payload = { toolIds };
  }
  const hash = await subjectHash("agent", String(id));
  if (hash === null) return toolFail(CHARACTER_MESSAGES.subjectGone);
  const out = await recordProposal(ctx, kind, payload, rationale.data, hash);
  if ("error" in out) return toolFail(out.error);
  return toolOk({ proposalId: out.id, kind });
}

// Solo sorveglianza (`poll`, mai `webhook`: l'indirizzo si mostra una volta e si crea dal modulo). Qui si controllano forma
// e appartenenza del tool all'app; le regole complete (livello, schema degli argomenti, limiti) sono dell'accettazione.
async function proposeTrigger(ctx: TurnContext, id: number, a: z.infer<typeof TriggerArgs>): Promise<string> {
  const rationale = rationaleSchema.safeParse(a.motivazione);
  if (!rationale.success) return toolFail(LUCIUS_MESSAGES.rationale);
  const row = await loadAgent(id);
  if (!row) return toolFail(CHARACTER_MESSAGES.subjectGone);
  const { motivazione: _m, ...config } = a;
  const shape = validateTriggerConfig({ kind: "poll", ...config });
  if (!shape.ok) return toolFail(shape.error);
  const [tool] = await db
    .select({ id: appToolsTable.id })
    .from(appToolsTable)
    .where(and(eq(appToolsTable.id, a.toolId), eq(appToolsTable.appId, row.agent.appId)))
    .limit(1);
  if (!tool) return toolFail(AGENT_MESSAGES.toolsNotOfApp);
  const out = await recordProposal(ctx, "agent_trigger_create", { agentId: id, ...config }, rationale.data, null);
  if ("error" in out) return toolFail(out.error);
  return toolOk({ proposalId: out.id, kind: "agent_trigger_create" });
}

async function runTool(call: ChatToolCall, ctx: TurnContext): Promise<string> {
  if (!isToolName(call.name)) return toolFail(LUCIUS_MESSAGES.unknownTool);
  const id = idFromSubject(ctx.subjectId);
  if (id === null) return toolFail(CHARACTER_MESSAGES.subjectGone);
  const parsed = SCHEMAS[call.name].safeParse(parseArgs(call.arguments));
  if (!parsed.success) return toolFail(LUCIUS_MESSAGES.badArgs);
  const a = parsed.data as Record<string, unknown>;
  try {
    const row = await loadAgent(id);
    if (!row) return toolFail(CHARACTER_MESSAGES.subjectGone);
    switch (call.name) {
      case "leggi_agente":
        return toolOk(await agentView(id));
      case "leggi_strumenti_app":
        return await readAppToolsTool(parsed.data as z.infer<typeof ReadAppToolsArgs>, row.agent.appId);
      case "leggi_skill":
        return await readSkillTool(parsed.data as z.infer<typeof ReadSkillArgs>);
      case "proponi_prompt_agente":
      case "proponi_strumenti_agente":
        return await propose(ctx, id, call.name, a);
      case "proponi_innesco":
        return await proposeTrigger(ctx, id, parsed.data as z.infer<typeof TriggerArgs>);
    }
  } catch {
    return toolFail(LUCIUS_MESSAGES.internal);
  }
}

export const agentSubject: SubjectHandler = {
  character: "lucius",
  type: "agent",
  resolve: async (_userId, subjectId) => {
    const id = idFromSubject(subjectId);
    const row = id === null ? null : await loadAgent(id);
    return row ? { title: `Agente · ${row.agent.name}` } : null;
  },
  context: async (_userId, subjectId) => {
    const id = idFromSubject(subjectId);
    const view = id === null ? null : await agentView(id);
    if (!view) return [];
    const catalog = await appToolsView(view.appId);
    const names = catalog.tools.map((t) => ({ id: t.id, name: t.name, level: t.level, status: t.status }));
    return [JSON.stringify(view), JSON.stringify({ catalogoStrumentiApp: names, troncato: catalog.truncated })];
  },
  tools: AGENT_TOOLS,
  runTool,
  codeApp: async (userId, subjectId) => {
    const id = idFromSubject(subjectId);
    const [row] =
      id === null
        ? []
        : await db
            .select({ app: appsTable })
            .from(agentsTable)
            .innerJoin(appsTable, eq(appsTable.id, agentsTable.appId))
            .where(eq(agentsTable.id, id))
            .limit(1);
    if (!row) return { defaultAppId: null, available: false };
    return { defaultAppId: row.app.id, available: (await codeAvailability(userId, row.app)).ok };
  },
};
