// Passaggio di consegne tra i personaggi: `passa_a` crea una scheda `handoff` («Chiedo a Lucius» / «Chiedo ad Alfred»)
// con la domanda già scritta. Nessun effetto sul server e nessuna chiamata tra modelli: il clic apre il pannello
// dell'altro personaggio sull'argomento.

import { eq } from "drizzle-orm";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { db, appsTable, teamInstancesTable } from "@workspace/db";
import { recordProposal } from "./proposals";
import { subjectsOf } from "./registry";
import { toolFail, toolOk, type Character, type TurnContext } from "./types";

export const HANDOFF_QUESTION_MAX = 2_000;

/** Argomenti solo di Lucius che stanno sulle chat esistenti: piano dell'app (id app) e chat di squadra (id squadra). */
const LUCIUS_EXTRA_SUBJECTS = ["plan", "team"] as const;

export const HANDOFF_MESSAGES = {
  invalidArgs: "argomenti non validi: servono argomento e domanda",
  emptyQuestion: "la domanda non può essere vuota",
  questionTooLong: `la domanda supera ${HANDOFF_QUESTION_MAX} caratteri`,
  unknownSubject: (subject: string) => `argomento ${subject} non disponibile per l'altro personaggio`,
  subjectNotFound: "argomento non trovato",
  internal: "errore interno dello strumento",
} as const;

export const HANDOFF_TOOL: ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "passa_a",
    description:
      "Passa la domanda all'altro personaggio: crea una scheda che l'utente può aprire, con la domanda già scritta e non inviata. Usala quando la richiesta spetta all'altro personaggio. Non ha altri effetti.",
    parameters: {
      type: "object",
      properties: {
        argomento: {
          type: "string",
          description:
            "Argomento dell'altro personaggio. Per Alfred: alfred_thread. Per Lucius: agent, skill, team_template, area_agents, area_skills, area_team_templates, plan (piano di un'app), team (squadra).",
        },
        oggetto: { type: "string", description: "Id dell'oggetto (agente, codice della skill, modello, app per plan, squadra per team); omesso per i fili e le aree." },
        domanda: { type: "string", description: `La domanda per l'altro personaggio, già scritta per lui (al massimo ${HANDOFF_QUESTION_MAX} caratteri).` },
      },
      required: ["argomento", "domanda"],
    },
  },
};

const otherOf = (c: Character): Character => (c === "alfred" ? "lucius" : "alfred");

function positiveId(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}

async function resolveExtra(subject: "plan" | "team", subjectId: string | null): Promise<boolean> {
  const id = positiveId(subjectId);
  if (id === null) return false;
  if (subject === "plan") {
    const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
    return !!app;
  }
  const [team] = await db.select({ id: teamInstancesTable.id }).from(teamInstancesTable).where(eq(teamInstancesTable.id, id)).limit(1);
  return !!team;
}

function parseArgs(args: unknown): { argomento: string; oggetto: string | null; domanda: string } | null {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if (typeof a.argomento !== "string" || typeof a.domanda !== "string") return null;
  let oggetto: string | null = null;
  if (typeof a.oggetto === "string") oggetto = a.oggetto.trim() || null;
  else if (typeof a.oggetto === "number" && Number.isSafeInteger(a.oggetto)) oggetto = String(a.oggetto);
  else if (a.oggetto !== undefined && a.oggetto !== null) return null;
  return { argomento: a.argomento.trim(), oggetto, domanda: a.domanda };
}

/** Esegue `passa_a` per conto di `character` (il destinatario è sempre l'altro). Stringa JSON, mai eccezioni. */
export async function runHandoff(character: Character, args: unknown, ctx: TurnContext): Promise<string> {
  try {
    const a = parseArgs(args);
    if (!a) return toolFail(HANDOFF_MESSAGES.invalidArgs);
    const question = a.domanda.trim();
    if (question === "") return toolFail(HANDOFF_MESSAGES.emptyQuestion);
    if (a.domanda.length > HANDOFF_QUESTION_MAX) return toolFail(HANDOFF_MESSAGES.questionTooLong);
    const to = otherOf(character);
    const extra = to === "lucius" && (LUCIUS_EXTRA_SUBJECTS as readonly string[]).includes(a.argomento);
    const handler = subjectsOf(to).find((h) => h.type === a.argomento);
    if (!extra && !handler) return toolFail(HANDOFF_MESSAGES.unknownSubject(a.argomento));
    const found = extra
      ? await resolveExtra(a.argomento as "plan" | "team", a.oggetto)
      : (await handler!.resolve(ctx.userId, a.oggetto)) !== null;
    if (!found) return toolFail(HANDOFF_MESSAGES.subjectNotFound);
    const payload = { to, subjectType: a.argomento, subjectId: a.oggetto, question };
    const r = await recordProposal(ctx, "handoff", payload, "", null);
    return "error" in r ? toolFail(r.error) : toolOk({ id: r.id });
  } catch {
    return toolFail(HANDOFF_MESSAGES.internal);
  }
}
