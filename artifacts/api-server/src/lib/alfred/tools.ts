import { z } from "zod";
import { InstanceError } from "../teams/instances";
import { CentralinoError, messageToLead, pendingQueue, readBulletin, readProposal, teamDetail, teamsStatus } from "../teams/centralino";
import { confirmDecision, invalidateOpenConfirmations, prepareDecision, ConfirmationError } from "./confirmations";
import { requireActiveSession } from "./sessions";
import { AlfredError } from "./gemini";
import { MEMORY_TOOL_NAMES, runMemoryTool } from "../memory/tools";

// Strumenti di Alfred (spec §4): il browser inoltra le chiamate di Gemini Live; qui si validano gli argomenti
// e si riusa il centralino. Esiti `{ok, result}` / `{ok:false, error}` con messaggi fissi in italiano.

export type AlfredToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export const ALFRED_TOOL_MESSAGES = {
  unknownTool: "strumento non trovato",
  badArgs: "argomenti non validi",
} as const;

const MAX_VOICE_TASKS = 5;
const MAX_VOICE_EVENTS = 5;
const MAX_OUTCOME = 200;

const teamId = z.number().int().positive();
const SCHEMAS = {
  squadre_stato: z.object({}).passthrough(),
  squadra_dettaglio: z.object({ id: teamId }),
  bollettino: z.object({}).passthrough(),
  coda_da_confermare: z.object({}).passthrough(),
  leggi_proposta: z.object({ numero: z.number().int().positive() }),
  scrivi_al_capo: z.object({ id: teamId, testo: z.string().min(1).max(4000) }),
  prepara_decisione: z.object({
    numero: z.number().int().positive(),
    decisione: z.enum(["approva", "rifiuta"]),
    nota: z.string().max(500).optional(),
    // Passi della proposta da non eseguire: "p3" o 3; normalizzati e controllati da `normalizeExclude`
    escludi: z.array(z.union([z.string().max(10), z.number()])).max(20).optional(),
  }),
  // Il modello può passare il codice come numero: gli zeri iniziali si ripristinano
  conferma_decisione: z.object({
    codice: z.union([
      z.string().regex(/^\d{6}$/),
      z
        .number()
        .int()
        .min(0)
        .max(999_999)
        .transform((n) => String(n).padStart(6, "0")),
    ]),
  }),
} as const;

export function isAlfredTool(name: string): name is keyof typeof SCHEMAS {
  return Object.hasOwn(SCHEMAS, name);
}

const isMemoryTool = (name: string): boolean => (MEMORY_TOOL_NAMES as readonly string[]).includes(name);

/** Dettaglio per la voce: obiettivo, stato del piano, pochi compiti ed eventi, nessun id interno oltre a quello della squadra. */
async function voiceDetail(userId: number, id: number) {
  const d = await teamDetail(userId, id);
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    objective: d.plan.objective,
    planStatus: d.plan.status,
    tasks: d.tasks.slice(0, MAX_VOICE_TASKS).map((t) => {
      const title = d.plan.tasks.find((p) => p.id === t.planTaskId)?.title ?? t.planTaskId;
      return { title, status: t.status, outcome: t.outcome === null ? null : t.outcome.slice(0, MAX_OUTCOME) };
    }),
    events: d.events.slice(0, MAX_VOICE_EVENTS).map((e) => e.text),
  };
}

/** Bollettino per la voce: il testo di ogni novità, senza id interni. */
async function voiceBulletin(userId: number) {
  const b = await readBulletin(userId);
  return { events: b.events.map((e) => ({ teamId: e.teamId, type: e.type, text: e.text })), remaining: b.remaining };
}

async function voiceQueue(userId: number) {
  const q = await pendingQueue(userId);
  return {
    actions: q.actions.map((a) => ({
      numero: a.number,
      tipo: a.kind,
      squadra: a.team?.name ?? null,
      destinatario: a.recipient,
      sintesi: a.summary,
      serveTokenApp: a.needsUserToken,
      // Numero di passi, solo per le proposte
      ...(a.steps !== undefined ? { passi: a.steps } : {}),
    })),
  };
}

/** Esegue uno strumento per una sessione attiva dell'utente (altrimenti AlfredError 404). */
export async function runAlfredTool(userId: number, sessionId: number, name: string, args: unknown): Promise<AlfredToolOutcome> {
  if (isMemoryTool(name)) {
    await requireActiveSession(userId, sessionId);
    // Gli argomenti li valida lo strumento di memoria; un errore imprevisto non deve far cadere la conversazione
    try {
      return await runMemoryTool(userId, "alfred", name, args ?? {});
    } catch {
      return { ok: false, error: "errore interno dello strumento" };
    }
  }
  if (!isAlfredTool(name)) throw new AlfredError(ALFRED_TOOL_MESSAGES.unknownTool, 404);
  await requireActiveSession(userId, sessionId);
  const parsed = SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) {
    // Anche una preparazione con argomenti non validi invalida il codice precedente della sessione
    if (name === "prepara_decisione") await invalidateOpenConfirmations(sessionId);
    return { ok: false, error: ALFRED_TOOL_MESSAGES.badArgs };
  }
  const a = parsed.data as Record<string, unknown>;
  try {
    switch (name) {
      case "squadre_stato":
        return { ok: true, result: await teamsStatus(userId) };
      case "squadra_dettaglio":
        return { ok: true, result: await voiceDetail(userId, a["id"] as number) };
      case "bollettino":
        return { ok: true, result: await voiceBulletin(userId) };
      case "coda_da_confermare":
        return { ok: true, result: await voiceQueue(userId) };
      case "scrivi_al_capo":
        return { ok: true, result: await messageToLead(userId, a["id"] as number, a["testo"] as string) };
      case "leggi_proposta":
        return { ok: true, result: await readProposal(userId, a["numero"] as number) };
      case "prepara_decisione":
        // `escludi` arriva grezzo: lo normalizza `prepareDecision` dopo aver chiuso le conferme aperte
        return { ok: true, result: await prepareDecision(userId, sessionId, a as Parameters<typeof prepareDecision>[2]) };
      case "conferma_decisione":
        return { ok: true, result: await confirmDecision(userId, sessionId, a["codice"] as string) };
    }
  } catch (err) {
    if (err instanceof CentralinoError || err instanceof InstanceError || err instanceof ConfirmationError) return { ok: false, error: err.message };
    throw err;
  }
}
