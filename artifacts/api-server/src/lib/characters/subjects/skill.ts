// Argomento `skill` di Lucius: una skill del catalogo (soggetto = codice). Lettura del contenuto e delle versioni, proposta
// di un nuovo contenuto (`skill_content`: l'accettazione crea la versione successiva). Alla proposta si controlla il
// contenuto con `validateSkillContent`; il resto è dell'accettazione.

import { z } from "zod";
import type { ChatToolCall } from "../../ai/chat-types";
import { SkillError, findSkill, getSkillVersion, listSkillVersions, validateSkillContent } from "../../teams/skills";
import { recordProposal } from "../proposals";
import { CHARACTER_MESSAGES, toolFail, toolOk, type SubjectHandler, type TurnContext } from "../types";
import { subjectHash } from "./hash";
import { LUCIUS_MESSAGES, RATIONALE_PROP, fn, parseArgs, positive, rationaleSchema, readSkillTool } from "./shared";

const MAX_HINTS = 50;
const MAX_HINT_LENGTH = 100;

export const SKILL_TOOLS = [
  fn("leggi_skill", "Rilegge la skill: tipo, versione corrente, contenuto, suggerimenti sugli strumenti, se è deprecata.", {}),
  fn("leggi_versione_skill", "Legge una versione precedente o corrente della skill.", { version: { type: "integer", description: "Numero di versione" } }, ["version"]),
  fn(
    "proponi_contenuto_skill",
    "Propone il nuovo contenuto della skill (l'accettazione crea la versione successiva). Non applica nulla: l'utente vede la scheda e decide.",
    {
      content: { type: "string", description: "Il contenuto completo" },
      toolHints: { type: "array", items: { type: "string" }, description: "Suggerimenti sugli strumenti (facoltativi)" },
      motivazione: RATIONALE_PROP,
    },
    ["content", "motivazione"],
  ),
];

const SCHEMAS = {
  leggi_skill: z.object({}).passthrough(),
  leggi_versione_skill: z.object({ version: positive }),
  proponi_contenuto_skill: z.object({
    content: z.string(),
    toolHints: z.array(z.string().min(1).max(MAX_HINT_LENGTH)).max(MAX_HINTS).optional(),
    motivazione: z.unknown(),
  }),
} as const;
type ToolName = keyof typeof SCHEMAS;
const isToolName = (name: string): name is ToolName => Object.hasOwn(SCHEMAS, name);

async function runTool(call: ChatToolCall, ctx: TurnContext): Promise<string> {
  if (!isToolName(call.name)) return toolFail(LUCIUS_MESSAGES.unknownTool);
  const code = ctx.subjectId;
  try {
    const skill = code === null ? null : await findSkill(code);
    if (!skill || code === null) return toolFail(CHARACTER_MESSAGES.subjectGone);
    const parsed = SCHEMAS[call.name].safeParse(parseArgs(call.arguments));
    if (!parsed.success) return toolFail(LUCIUS_MESSAGES.badArgs);
    switch (call.name) {
      case "leggi_skill":
        return await readSkillTool({ code });
      case "leggi_versione_skill": {
        const v = await getSkillVersion(code, (parsed.data as { version: number }).version);
        return toolOk({ code: v.code, version: v.version, content: v.content, toolHints: v.toolHints });
      }
      case "proponi_contenuto_skill": {
        const a = parsed.data as z.infer<typeof SCHEMAS.proponi_contenuto_skill>;
        const rationale = rationaleSchema.safeParse(a.motivazione);
        if (!rationale.success) return toolFail(LUCIUS_MESSAGES.rationale);
        const error = validateSkillContent(skill.kind, a.content);
        if (error) return toolFail(error);
        if (skill.kind === "node" && (a.toolHints?.length ?? 0) > 0) return toolFail("i suggerimenti sugli strumenti valgono solo per le skill Botcave");
        const hash = await subjectHash("skill", code);
        if (hash === null) return toolFail(CHARACTER_MESSAGES.subjectGone);
        const payload = a.toolHints === undefined ? { content: a.content } : { content: a.content, toolHints: a.toolHints };
        const out = await recordProposal(ctx, "skill_content", payload, rationale.data, hash);
        if ("error" in out) return toolFail(out.error);
        return toolOk({ proposalId: out.id, kind: "skill_content" });
      }
    }
  } catch (err) {
    if (err instanceof SkillError) return toolFail(err.message);
    return toolFail(LUCIUS_MESSAGES.internal);
  }
}

export const skillSubject: SubjectHandler = {
  character: "lucius",
  type: "skill",
  resolve: async (_userId, subjectId) => {
    const skill = subjectId === null ? null : await findSkill(subjectId);
    return skill ? { title: `Skill · ${skill.code}` } : null;
  },
  context: async (_userId, subjectId) => {
    const skill = subjectId === null ? null : await findSkill(subjectId);
    if (!skill) return [];
    const versions = (await listSkillVersions(skill.code)).length;
    return [
      JSON.stringify({
        code: skill.code,
        name: skill.name,
        description: skill.description,
        kind: skill.kind,
        currentVersion: skill.currentVersion,
        versions,
        deprecated: skill.deprecated,
        content: skill.content,
        toolHints: skill.toolHints,
      }),
    ];
  },
  tools: SKILL_TOOLS,
  runTool,
};

