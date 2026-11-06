// Argomento `team_template` di Lucius: un modello di squadra. Lettura del manifesto (ruoli con skill e strumenti), delle
// skill e del catalogo dei tool; proposta dei ruoli (`template_roles`: l'accettazione salva la versione successiva con
// `validateRoles`). Alla proposta si controllano forma e limiti. Un modello archiviato si legge ma non si modifica.

import { z } from "zod";
import type { ChatToolCall } from "../../ai/chat-types";
import { TEMPLATE_MESSAGES, TemplateError, getTemplate, getTemplateRow } from "../../teams/templates";
import { recordProposal } from "../proposals";
import { CHARACTER_MESSAGES, toolFail, toolOk, type SubjectHandler, type TurnContext } from "../types";
import { subjectHash } from "./hash";
import {
  LUCIUS_MESSAGES, READ_APP_TOOLS_TOOL, READ_SKILL_TOOL, RATIONALE_PROP, ReadAppToolsArgs, ReadSkillArgs, checkRoles, fn, idFromSubject,
  parseArgs, rationaleSchema, readAppToolsTool, readSkillTool,
} from "./shared";

export const TEMPLATE_TOOLS = [
  fn("leggi_modello", "Rilegge il modello di squadra: nome, descrizione, versione e ruoli con skill, strumenti e modello AI.", {}),
  READ_SKILL_TOOL,
  READ_APP_TOOLS_TOOL,
  fn(
    "proponi_ruoli_modello",
    "Propone l'elenco completo dei ruoli del modello (nuova versione). Ogni ruolo: key, name, task (identità), isLead, runsOn cloud|node, aiModelId (null per node), tools (id), skills (codici). Un solo capo. Non applica nulla: l'utente vede la scheda e decide.",
    { roles: { type: "array", items: { type: "object" }, description: "I ruoli, nel formato del manifesto del modello" }, motivazione: RATIONALE_PROP },
    ["roles", "motivazione"],
  ),
];

const SCHEMAS = {
  leggi_modello: z.object({}).passthrough(),
  leggi_skill: ReadSkillArgs,
  leggi_strumenti_app: ReadAppToolsArgs,
  proponi_ruoli_modello: z.object({ roles: z.unknown(), motivazione: z.unknown() }),
} as const;
type ToolName = keyof typeof SCHEMAS;
const isToolName = (name: string): name is ToolName => Object.hasOwn(SCHEMAS, name);

async function findTemplate(id: number | null) {
  if (id === null) return null;
  try {
    return await getTemplateRow(id);
  } catch (err) {
    if (err instanceof TemplateError && err.status === 404) return null;
    throw err;
  }
}

async function runTool(call: ChatToolCall, ctx: TurnContext): Promise<string> {
  if (!isToolName(call.name)) return toolFail(LUCIUS_MESSAGES.unknownTool);
  const id = idFromSubject(ctx.subjectId);
  try {
    const tpl = await findTemplate(id);
    if (!tpl || id === null) return toolFail(CHARACTER_MESSAGES.subjectGone);
    const parsed = SCHEMAS[call.name].safeParse(parseArgs(call.arguments));
    if (!parsed.success) return toolFail(LUCIUS_MESSAGES.badArgs);
    switch (call.name) {
      case "leggi_modello": {
        const v = await getTemplate(id);
        return toolOk({ id: v.id, name: v.name, description: v.description, version: v.version, archived: v.archived, roles: v.roles });
      }
      case "leggi_skill":
        return await readSkillTool(parsed.data as z.infer<typeof ReadSkillArgs>);
      case "leggi_strumenti_app":
        return await readAppToolsTool(parsed.data as z.infer<typeof ReadAppToolsArgs>, null);
      case "proponi_ruoli_modello": {
        const a = parsed.data as { roles: unknown; motivazione: unknown };
        if (tpl.archived) return toolFail(TEMPLATE_MESSAGES.archived);
        const rationale = rationaleSchema.safeParse(a.motivazione);
        if (!rationale.success) return toolFail(LUCIUS_MESSAGES.rationale);
        const checked = checkRoles(a.roles);
        if (!checked.ok) return toolFail(checked.error);
        const hash = await subjectHash("team_template", String(id));
        if (hash === null) return toolFail(CHARACTER_MESSAGES.subjectGone);
        const out = await recordProposal(ctx, "template_roles", { roles: checked.roles }, rationale.data, hash);
        if ("error" in out) return toolFail(out.error);
        return toolOk({ proposalId: out.id, kind: "template_roles" });
      }
    }
  } catch {
    return toolFail(LUCIUS_MESSAGES.internal);
  }
}

export const teamTemplateSubject: SubjectHandler = {
  character: "lucius",
  type: "team_template",
  resolve: async (_userId, subjectId) => {
    const tpl = await findTemplate(idFromSubject(subjectId));
    return tpl ? { title: `Modello di squadra · ${tpl.name}` } : null;
  },
  context: async (_userId, subjectId) => {
    const id = idFromSubject(subjectId);
    if (id === null || !(await findTemplate(id))) return [];
    const v = await getTemplate(id);
    return [JSON.stringify({ id: v.id, name: v.name, description: v.description, version: v.version, archived: v.archived, roles: v.roles })];
  },
  tools: TEMPLATE_TOOLS,
  runTool,
};

