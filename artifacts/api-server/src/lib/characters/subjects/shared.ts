// Pezzi comuni agli argomenti di Lucius: definizione degli strumenti, lettura degli argomenti, strumenti condivisi di
// lettura (catalogo dei tool di un'app, skill) e controlli di forma delle proposte. Mai indirizzi o segreti delle app.

import { and, asc, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { db, appToolsTable, appsTable } from "@workspace/db";
import { maskSchema } from "../../team-chat/tools";
import { MAX_ROLES, MAX_SKILLS_PER_ROLE, TemplateRoleSchema, type TemplateRole } from "../../teams/manifest";
import { SkillError, getSkill } from "../../teams/skills";
import { effectiveLevel } from "../../tools/levels";
import { RATIONALE_MAX, toolFail, toolOk } from "../types";

export const LIST_MAX = 50;
export const LUCIUS_MESSAGES = {
  badArgs: "argomenti non validi",
  unknownTool: "strumento sconosciuto",
  internal: "errore interno dello strumento",
  appNotFound: "app non trovata",
  rationale: `la motivazione è obbligatoria, al massimo ${RATIONALE_MAX} caratteri`,
  rolesInvalid: "ruoli non validi: controlla la forma del manifesto",
  tooManyRoles: `i ruoli sono da 1 a ${MAX_ROLES}`,
  tooManySkills: `al massimo ${MAX_SKILLS_PER_ROLE} skill per ruolo`,
} as const;

export const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ChatCompletionFunctionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const RATIONALE_PROP = { type: "string", description: `Perché questa proposta, in poche frasi (al massimo ${RATIONALE_MAX} caratteri).` };
export const positive = z.number().int().positive();
export const rationaleSchema = z.string().trim().min(1).max(RATIONALE_MAX);

export function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

const escapeLike = (v: string): string => v.replace(/[\\%_]/g, (c) => `\\${c}`);
export const likePattern = (q: string): string => `%${escapeLike(q.trim())}%`;

/** Ruoli di un modello: 1..20, forma del manifesto e al più 30 skill per ruolo. La validazione completa è dell'accettazione. */
export function checkRoles(roles: unknown): { ok: true; roles: TemplateRole[] } | { ok: false; error: string } {
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > MAX_ROLES) return { ok: false, error: LUCIUS_MESSAGES.tooManyRoles };
  const parsed = z.array(TemplateRoleSchema).safeParse(roles);
  if (!parsed.success) return { ok: false, error: LUCIUS_MESSAGES.rolesInvalid };
  if (parsed.data.some((r) => r.skills.length > MAX_SKILLS_PER_ROLE)) return { ok: false, error: LUCIUS_MESSAGES.tooManySkills };
  return { ok: true, roles: parsed.data };
}

// --- Strumenti di lettura condivisi ----------------------------------------------------------------

export const READ_SKILL_TOOL = fn("leggi_skill", "Legge una skill del catalogo: tipo, versione corrente, contenuto, suggerimenti sugli strumenti.", {
  code: { type: "string", description: "Codice della skill" },
}, ["code"]);

export const READ_APP_TOOLS_TOOL = fn(
  "leggi_strumenti_app",
  "Catalogo degli strumenti di un'app: nome, tipo, livello, stato e schema dei parametri (i riservati sono oscurati). Al massimo 50 voci, con ricerca per nome.",
  { appId: { type: "integer", description: "Id dell'app (per un agente, di default la sua)" }, q: { type: "string", description: "Testo da cercare nel nome" } },
);

export const ReadSkillArgs = z.object({ code: z.string().min(1).max(100) });
export const ReadAppToolsArgs = z.object({ appId: positive.optional(), q: z.string().max(100).optional() });

export async function readSkillTool(args: z.infer<typeof ReadSkillArgs>): Promise<string> {
  try {
    const s = await getSkill(args.code);
    return toolOk({
      code: s.code,
      name: s.name,
      description: s.description,
      kind: s.kind,
      currentVersion: s.currentVersion,
      deprecated: s.deprecated,
      content: s.content,
      toolHints: s.toolHints,
    });
  } catch (err) {
    if (err instanceof SkillError) return toolFail(err.message);
    throw err;
  }
}

/** Catalogo dei tool di un'app, senza definizioni con header né indirizzi. */
export async function appToolsView(appId: number, q?: string) {
  const conditions = [eq(appToolsTable.appId, appId)];
  if (q?.trim()) conditions.push(ilike(appToolsTable.name, likePattern(q)));
  const rows = await db
    .select()
    .from(appToolsTable)
    .where(and(...conditions))
    .orderBy(asc(appToolsTable.name))
    .limit(LIST_MAX + 1);
  return {
    tools: rows.slice(0, LIST_MAX).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      kind: t.kind,
      identity: t.identity,
      level: effectiveLevel(t),
      status: t.status,
      paramsSchema: maskSchema(t.paramsSchema),
    })),
    truncated: rows.length > LIST_MAX,
  };
}

export async function readAppToolsTool(args: z.infer<typeof ReadAppToolsArgs>, defaultAppId: number | null): Promise<string> {
  const appId = args.appId ?? defaultAppId;
  if (appId === null) return toolFail(LUCIUS_MESSAGES.badArgs);
  const [app] = await db.select({ id: appsTable.id, name: appsTable.name }).from(appsTable).where(eq(appsTable.id, appId)).limit(1);
  if (!app) return toolFail(LUCIUS_MESSAGES.appNotFound);
  return toolOk({ app: app.name, ...(await appToolsView(appId, args.q)) });
}

export const idFromSubject = (subjectId: string | null): number | null => {
  if (subjectId === null || !/^[1-9][0-9]{0,9}$/.test(subjectId)) return null;
  return Number(subjectId);
};
