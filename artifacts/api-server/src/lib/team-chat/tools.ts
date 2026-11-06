// Strumenti di Lucius nella chat di squadra. `TeamChatToolRunner.run` restituisce sempre una stringa JSON
// (`{ok: true, result}` o `{ok: false, error}` con messaggio fisso): gli errori del modello diventano testo da
// correggere. Le proposte restano in memoria per la durata del turno; le salva `run-turn.ts` alla fine.

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { eq } from "drizzle-orm";
import { db, appToolsTable, appsTable } from "@workspace/db";
import type { ChatToolCall } from "../ai/chat-types";
import { MEMORY_TOOLS, MEMORY_TOOL_NAMES, runMemoryTool } from "../memory/tools";
import { MAX_TASK } from "../teams/manifest";
import { MAX_SKILL_CONTENT } from "../teams/skills";
import { effectiveLevel } from "../tools/levels";
import { renderTeam, type TeamSnapshot } from "./context";
import type { TeamChatProposalKind } from "./decide";
import { parseInstructionsFile } from "./instructions-file";
import { loadTeamSnapshot } from "./snapshot";

export const MAX_PROPOSALS_PER_TURN = 10;
export const RATIONALE_MAX = 1_000;

export const TEAM_CHAT_TOOL_MESSAGES = {
  invalidArgs: "argomenti non validi: serve un oggetto JSON",
  unknownTool: (name: string) => `strumento sconosciuto: ${name}`,
  roleMissing: (key: string) => `ruolo ${key} inesistente`,
  tooManyProposals: `hai già proposto ${MAX_PROPOSALS_PER_TURN} schede in questo turno`,
  skillMissing: (code: string) => `skill ${code} non presente nella squadra`,
  toolMissing: "strumento non presente nella squadra",
  emptyText: "il testo non può essere vuoto",
  textTooLong: `il testo supera ${MAX_TASK} caratteri`,
  markdownTooLong: `il file supera ${MAX_SKILL_CONTENT} caratteri`,
  rationale: `la motivazione è obbligatoria, al massimo ${RATIONALE_MAX} caratteri`,
  internal: "errore interno dello strumento",
} as const;

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const ROLE_KEY = { type: "string", description: "Key del ruolo, come nei dati della squadra." };
const RATIONALE = { type: "string", description: `Perché questa proposta, in poche frasi (al massimo ${RATIONALE_MAX} caratteri).` };

export const TEAM_CHAT_TOOLS: ChatCompletionFunctionTool[] = [
  fn("leggi_squadra", "Rilegge la definizione completa della squadra: ruoli, identità, strumenti, skill con il contenuto, PLAN.", {}, []),
  fn("leggi_skill", "Legge il contenuto completo di una skill usata dalla squadra (alla versione fissata o specializzata).", { code: { type: "string", description: "Codice della skill." } }, ["code"]),
  fn(
    "leggi_strumento",
    "Legge la definizione di uno strumento usato dalla squadra e lo schema dei suoi parametri (i parametri riservati sono oscurati).",
    { id: { type: "integer", description: "Id dello strumento, come nei dati della squadra." } },
    ["id"],
  ),
  fn(
    "proponi_identita",
    "Propone una nuova identità per un ruolo (chi è e qual è il suo mandato stabile, in poche righe). Non applica nulla: l'utente la vede come scheda e decide.",
    { roleKey: ROLE_KEY, testo: { type: "string", description: `L'identità, al massimo ${MAX_TASK} caratteri.` }, motivazione: RATIONALE },
    ["roleKey", "testo", "motivazione"],
  ),
  fn(
    "proponi_istruzioni",
    "Propone il file di istruzioni (Markdown) di un ruolo, con il frontmatter `name` = key del ruolo e `description`. Non applica nulla: l'utente lo vede come scheda e decide.",
    { roleKey: ROLE_KEY, markdown: { type: "string", description: `Il file completo, al massimo ${MAX_SKILL_CONTENT} caratteri.` }, motivazione: RATIONALE },
    ["roleKey", "markdown", "motivazione"],
  ),
  ...MEMORY_TOOLS,
];

export interface NewTeamChatProposal {
  kind: TeamChatProposalKind;
  roleKey: string;
  payload: { text: string } | { markdown: string };
  rationale: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Schema dei parametri con le proprietà `x-sensitive` ridotte al tipo: niente default, esempi o descrizioni. */
export function maskSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  if (schema["x-sensitive"] === true) {
    return typeof schema["type"] === "string" ? { type: schema["type"], "x-sensitive": true } : { "x-sensitive": true };
  }
  const out: Record<string, unknown> = { ...schema };
  const props = schema["properties"];
  if (isPlainObject(props)) out["properties"] = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, maskSchema(v)]));
  if (isPlainObject(schema["items"])) out["items"] = maskSchema(schema["items"]);
  return out;
}

/** Della definizione si tiene solo la forma della chiamata, mai header o altro. */
function publicDefinition(kind: string, definition: unknown): unknown {
  if (!isPlainObject(definition)) return null;
  if (kind === "http") return { method: definition["method"], path: definition["path"], paramLocations: definition["paramLocations"] };
  if (kind === "mcp") return { mcpName: definition["mcpName"] };
  return null;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

const ok = (result: unknown) => JSON.stringify({ ok: true, result });
const fail = (error: string) => JSON.stringify({ ok: false, error });

export class TeamChatToolRunner {
  readonly proposals: NewTeamChatProposal[] = [];

  constructor(
    private readonly instanceId: number,
    private readonly userId: number,
    private snapshot: TeamSnapshot | null = null,
  ) {}

  private async team(): Promise<TeamSnapshot> {
    this.snapshot ??= await loadTeamSnapshot(this.instanceId);
    return this.snapshot;
  }

  async run(call: ChatToolCall): Promise<string> {
    const args = parseArgs(call.arguments);
    if (!args) return fail(TEAM_CHAT_TOOL_MESSAGES.invalidArgs);
    try {
      if ((MEMORY_TOOL_NAMES as readonly string[]).includes(call.name)) {
        const r = await runMemoryTool(this.userId, "lucius", call.name, args);
        return r.ok ? ok(r.result) : fail(r.error);
      }
      switch (call.name) {
        case "leggi_squadra":
          return ok(renderTeam(await this.team()));
        case "leggi_skill":
          return this.readSkill(args);
        case "leggi_strumento":
          return await this.readTool(args);
        case "proponi_identita":
          return this.propose("role_identity", args);
        case "proponi_istruzioni":
          return this.propose("role_instructions", args);
        default:
          return fail(TEAM_CHAT_TOOL_MESSAGES.unknownTool(call.name));
      }
    } catch {
      return fail(TEAM_CHAT_TOOL_MESSAGES.internal);
    }
  }

  private async readSkill(args: Record<string, unknown>): Promise<string> {
    const code = typeof args.code === "string" ? args.code : "";
    const skill = (await this.team()).roles.flatMap((r) => r.skills).find((s) => s.code === code);
    return skill ? ok(skill) : fail(TEAM_CHAT_TOOL_MESSAGES.skillMissing(code));
  }

  private async readTool(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "number" && Number.isInteger(args.id) ? args.id : null;
    const inTeam = id !== null && (await this.team()).roles.some((r) => r.tools.some((t) => t.id === id));
    if (!inTeam) return fail(TEAM_CHAT_TOOL_MESSAGES.toolMissing);
    const [found] = await db
      .select({ tool: appToolsTable, appName: appsTable.name })
      .from(appToolsTable)
      .innerJoin(appsTable, eq(appsTable.id, appToolsTable.appId))
      .where(eq(appToolsTable.id, id))
      .limit(1);
    if (!found) return fail(TEAM_CHAT_TOOL_MESSAGES.toolMissing);
    const { tool } = found;
    const level = effectiveLevel(tool);
    return ok({
      id: tool.id,
      name: tool.name,
      app: found.appName,
      description: tool.description,
      kind: tool.kind,
      identity: tool.identity,
      level,
      available: tool.status === "active" && level !== "L3",
      definition: publicDefinition(tool.kind, tool.definition),
      paramsSchema: maskSchema(tool.paramsSchema),
    });
  }

  private async propose(kind: TeamChatProposalKind, args: Record<string, unknown>): Promise<string> {
    if (this.proposals.length >= MAX_PROPOSALS_PER_TURN) return fail(TEAM_CHAT_TOOL_MESSAGES.tooManyProposals);
    const roleKey = typeof args.roleKey === "string" ? args.roleKey : "";
    if (!(await this.team()).roles.some((r) => r.key === roleKey)) return fail(TEAM_CHAT_TOOL_MESSAGES.roleMissing(roleKey));
    const rationale = typeof args.motivazione === "string" ? args.motivazione.trim() : "";
    if (!rationale || rationale.length > RATIONALE_MAX) return fail(TEAM_CHAT_TOOL_MESSAGES.rationale);

    let payload: NewTeamChatProposal["payload"];
    if (kind === "role_identity") {
      const text = typeof args.testo === "string" ? args.testo.trim() : "";
      if (!text) return fail(TEAM_CHAT_TOOL_MESSAGES.emptyText);
      if (text.length > MAX_TASK) return fail(TEAM_CHAT_TOOL_MESSAGES.textTooLong);
      payload = { text };
    } else {
      const markdown = typeof args.markdown === "string" ? args.markdown : "";
      if (markdown.length > MAX_SKILL_CONTENT) return fail(TEAM_CHAT_TOOL_MESSAGES.markdownTooLong);
      const parsed = parseInstructionsFile(markdown, roleKey);
      if (!parsed.ok) return fail(parsed.error);
      payload = { markdown };
    }
    this.proposals.push({ kind, roleKey, payload, rationale });
    return ok(`scheda ${this.proposals.length} registrata: l'utente la vedrà e deciderà`);
  }
}
