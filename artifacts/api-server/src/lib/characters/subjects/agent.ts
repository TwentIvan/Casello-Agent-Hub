// Argomento `agent` di Lucius: un agente di un'app. Strumenti di lettura (agente, catalogo dei tool dell'app, skill) e due
// proposte: il prompt di sistema (`agent_prompt`) e i tool collegati (`agent_tools`, solo agenti di ruolo `area`).
// Alla proposta si controllano solo forma e limiti; la validazione completa è dell'accettazione. Mai indirizzi né segreti.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, agentToolsTable, agentsTable, aiModelsTable, appToolsTable, appsTable } from "@workspace/db";
import type { ChatToolCall } from "../../ai/chat-types";
import { effectiveLevel } from "../../tools/levels";
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
];

const SCHEMAS = {
  leggi_agente: z.object({}).passthrough(),
  leggi_strumenti_app: ReadAppToolsArgs,
  leggi_skill: ReadSkillArgs,
  proponi_prompt_agente: z.object({ systemPrompt: z.string().min(1), motivazione: z.unknown() }),
  proponi_strumenti_agente: z.object({ toolIds: z.array(positive).max(500), motivazione: z.unknown() }),
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
};
