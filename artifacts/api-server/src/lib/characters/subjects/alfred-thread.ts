// Argomento `alfred_thread`: il filo unico di Alfred scritto. Strumenti del centralino (come Alfred vocale, senza il
// doppio passo del codice) più `leggi_run` e `proponi_decisione`, che crea una scheda `decision` da accettare in console.
// Contesto e risultati senza segreti né indirizzi delle app.

import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { db, aiAccountsTable, aiModelsTable, characterConversationsTable, runsTable, type CharacterConversation } from "@workspace/db";
import type { ChatToolCall } from "../../ai/chat-types";
import { InstanceError, getInstance, listInstances } from "../../teams/instances";
import {
  CENTRALINO_MESSAGES,
  CentralinoError,
  messageToLead,
  normalizeExclude,
  pendingQueue,
  previewExclusion,
  readBulletin,
  readProposal,
  teamDetail,
  teamsStatus,
} from "../../teams/centralino";
import { PROPOSAL_MESSAGES } from "../../actions/proposal";
import { unreadBulletin } from "../../teams/events";
import { recordProposal } from "../proposals";
import { characterModelFor } from "../settings";
import { toolFail, toolOk, type PageContext, type SubjectHandler, type TurnContext } from "../types";

const MAX_CONTEXT_TEAMS = 30;
const MAX_TASKS = 5;
const MAX_EVENTS = 5;
const MAX_OUTCOME = 200;
const RUN_TEXT_MAX = 2_000;
const RUN_ERROR_MAX = 500;

export const ALFRED_THREAD_MESSAGES = {
  badArgs: "argomenti non validi",
  runNotFound: "run non trovata",
  actionNotFound: "voce non trovata tra quelle da confermare",
  noteOnlyWithReject: "la nota si usa solo con il rifiuto",
  internal: "errore interno dello strumento",
} as const;

// --- Filo ----------------------------------------------------------------------------------------

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

async function findOpenThread(userId: number): Promise<CharacterConversation | null> {
  const [row] = await db
    .select()
    .from(characterConversationsTable)
    .where(
      and(
        eq(characterConversationsTable.userId, userId),
        eq(characterConversationsTable.character, "alfred"),
        eq(characterConversationsTable.subjectType, "alfred_thread"),
        isNull(characterConversationsTable.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insertThread(userId: number): Promise<CharacterConversation> {
  const aiModelId = await characterModelFor(userId, "alfred");
  const [row] = await db
    .insert(characterConversationsTable)
    .values({ userId, character: "alfred", subjectType: "alfred_thread", subjectId: null, subjectTitle: "Alfred", aiModelId, title: "" })
    .returning();
  return row!;
}

/** Il filo aperto di Alfred dell'utente; se manca lo crea con il modello di Alfred. Due richieste insieme: stesso filo. */
export async function getAlfredThread(userId: number): Promise<CharacterConversation> {
  const open = await findOpenThread(userId);
  if (open) return open;
  try {
    return await insertThread(userId);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = await findOpenThread(userId);
    if (again) return again;
    throw err;
  }
}

/** Archivia il filo aperto (resta in sola lettura) e ne apre uno nuovo. */
export async function restartAlfredThread(userId: number): Promise<CharacterConversation> {
  await db
    .update(characterConversationsTable)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(characterConversationsTable.userId, userId),
        eq(characterConversationsTable.subjectType, "alfred_thread"),
        isNull(characterConversationsTable.archivedAt),
      ),
    );
  return getAlfredThread(userId);
}

// --- Strumenti -----------------------------------------------------------------------------------

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ChatCompletionFunctionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const ALFRED_THREAD_TOOLS: ChatCompletionFunctionTool[] = [
  fn("squadre_stato", "Una riga per ogni squadra attiva dell'utente: piano, compiti, eventi non letti.", {}),
  fn("squadra_dettaglio", "Dettaglio di una squadra: obiettivo, stato del piano, ultimi compiti ed eventi.", { id: { type: "integer", description: "Id della squadra" } }, ["id"]),
  fn("bollettino", "Novità non lette delle squadre; le restituite si segnano come lette.", {}),
  fn("coda_da_confermare", "Le voci in attesa di conferma dell'utente, con numero, tipo, squadra e sintesi; per le proposte il numero di passi.", {}),
  fn(
    "leggi_proposta",
    "Legge una proposta della coda: titolo, motivo e passi con numero e sintesi. Usalo prima di proporre la decisione su una proposta.",
    { numero: { type: "integer", description: "Numero della voce in coda" } },
    ["numero"],
  ),
  fn(
    "scrivi_al_capo",
    "Manda un messaggio al capo di una squadra attiva; parte un suo turno. Scrivi solo ciò che l'utente ha chiesto.",
    { id: { type: "integer", description: "Id della squadra" }, testo: { type: "string", description: "Il messaggio per il capo" } },
    ["id", "testo"],
  ),
  fn("leggi_run", "Stato, esito, errore, durata e costo di una run dell'utente.", { id: { type: "integer", description: "Id della run" } }, ["id"]),
  fn(
    "proponi_decisione",
    "Prepara una scheda con cui l'utente approva o rifiuta una voce della coda: non decide nulla da sola, l'utente conferma in console. Leggi prima la voce e riportane numero e sintesi.",
    {
      numero: { type: "integer", description: "Numero della voce in coda" },
      decisione: { type: "string", enum: ["approva", "rifiuta"] },
      nota: { type: "string", description: "Motivo del rifiuto (solo con rifiuta, al massimo 500 caratteri)" },
      escludi: {
        type: "array",
        items: { type: "string" },
        description: "Solo per le proposte e con approva: id dei passi da non eseguire, es. p3",
      },
    },
    ["numero", "decisione"],
  ),
];

const positive = z.number().int().positive();
const SCHEMAS = {
  squadre_stato: z.object({}).passthrough(),
  squadra_dettaglio: z.object({ id: positive }),
  bollettino: z.object({}).passthrough(),
  coda_da_confermare: z.object({}).passthrough(),
  leggi_proposta: z.object({ numero: positive }),
  scrivi_al_capo: z.object({ id: positive, testo: z.string().min(1).max(4000) }),
  leggi_run: z.object({ id: positive }),
  proponi_decisione: z.object({
    numero: positive,
    decisione: z.enum(["approva", "rifiuta"]),
    nota: z.string().max(500).optional(),
    escludi: z.array(z.union([z.string().max(10), z.number()])).max(20).optional(),
  }),
} as const;

type ToolName = keyof typeof SCHEMAS;
const isToolName = (name: string): name is ToolName => Object.hasOwn(SCHEMAS, name);

async function voiceDetail(userId: number, id: number) {
  const d = await teamDetail(userId, id);
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    objective: d.plan.objective,
    planStatus: d.plan.status,
    tasks: d.tasks.slice(0, MAX_TASKS).map((t) => {
      const title = d.plan.tasks.find((p) => p.id === t.planTaskId)?.title ?? t.planTaskId;
      return { title, status: t.status, outcome: t.outcome === null ? null : t.outcome.slice(0, MAX_OUTCOME) };
    }),
    events: d.events.slice(0, MAX_EVENTS).map((e) => e.text),
  };
}

async function queueView(userId: number) {
  const q = await pendingQueue(userId);
  return {
    actions: q.actions.map((a) => ({
      numero: a.number,
      tipo: a.kind,
      squadra: a.team?.name ?? null,
      destinatario: a.recipient,
      sintesi: a.summary,
      // Numero di passi, solo per le proposte
      passi: a.steps,
      serveTokenApp: a.needsUserToken,
    })),
  };
}

/** Run dell'utente: proprietario = chi possiede l'account AI del modello con cui è partita. Nessun passo né argomento. */
async function readRun(userId: number, id: number) {
  const [row] = await db
    .select({ run: runsTable })
    .from(runsTable)
    .innerJoin(aiModelsTable, eq(aiModelsTable.id, runsTable.aiModelId))
    .innerJoin(aiAccountsTable, eq(aiAccountsTable.id, aiModelsTable.accountId))
    .where(and(eq(runsTable.id, id), eq(aiAccountsTable.userId, userId)))
    .limit(1);
  if (!row) return null;
  const r = row.run;
  return {
    id: r.id,
    status: r.status,
    output: r.output === null ? null : r.output.slice(0, RUN_TEXT_MAX),
    error: r.errorMessage === null ? null : r.errorMessage.slice(0, RUN_ERROR_MAX),
    durationMs: r.durationMs,
    costUsd: r.costUsd,
  };
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function proposeDecision(ctx: TurnContext, a: z.infer<typeof SCHEMAS.proponi_decisione>): Promise<string> {
  if (a.nota !== undefined && a.decisione !== "rifiuta") return toolFail(ALFRED_THREAD_MESSAGES.noteOnlyWithReject);
  const exclude = normalizeExclude(a.escludi);
  if (exclude === null) return toolFail(PROPOSAL_MESSAGES.badExclude);
  if (exclude.length > 0 && a.decisione !== "approva") return toolFail(CENTRALINO_MESSAGES.excludeOnlyWithApprove);
  const q = await pendingQueue(ctx.userId);
  const item = q.actions.find((x) => x.number === a.numero);
  if (!item) return toolFail(ALFRED_THREAD_MESSAGES.actionNotFound);
  // Esclusioni controllate subito sui passi della voce (CentralinoError → messaggio fisso)
  const preview = a.decisione === "approva" ? await previewExclusion(ctx.userId, item.number, exclude) : null;
  const payload = {
    number: item.number,
    decision: a.decisione,
    note: a.nota ?? null,
    kind: item.kind,
    teamName: item.team?.name ?? null,
    summary: item.summary,
    needsUserToken: item.needsUserToken,
    exclude: exclude.length > 0 ? exclude : null,
  };
  const out = await recordProposal(ctx, "decision", payload, "", sha256(`pending\n${item.summary}`));
  if ("error" in out) return toolFail(out.error);
  return toolOk({
    proposalId: out.id,
    numero: item.number,
    decisione: a.decisione,
    sintesi: item.summary,
    ...(item.kind === "proposal" ? { passiEsclusi: preview?.excluded ?? [], passiSaltati: preview?.skipped ?? [] } : {}),
  });
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

async function runTool(call: ChatToolCall, ctx: TurnContext): Promise<string> {
  if (!isToolName(call.name)) return toolFail("strumento sconosciuto");
  const parsed = SCHEMAS[call.name].safeParse(parseArgs(call.arguments));
  if (!parsed.success) return toolFail(ALFRED_THREAD_MESSAGES.badArgs);
  const a = parsed.data as Record<string, unknown>;
  const userId = ctx.userId;
  try {
    switch (call.name) {
      case "squadre_stato":
        // Il modello della chat riassume da sé: nessuna chiamata al modello del centralino, fuori dai tetti dei personaggi
        return toolOk(await teamsStatus(userId, { summarize: false }));
      case "squadra_dettaglio":
        return toolOk(await voiceDetail(userId, a["id"] as number));
      case "bollettino": {
        const b = await readBulletin(userId);
        return toolOk({ events: b.events.map((e) => ({ teamId: e.teamId, type: e.type, text: e.text })), remaining: b.remaining });
      }
      case "coda_da_confermare":
        return toolOk(await queueView(userId));
      case "leggi_proposta":
        return toolOk(await readProposal(userId, a["numero"] as number));
      case "scrivi_al_capo":
        return toolOk(await messageToLead(userId, a["id"] as number, a["testo"] as string));
      case "leggi_run": {
        const run = await readRun(userId, a["id"] as number);
        return run ? toolOk(run) : toolFail(ALFRED_THREAD_MESSAGES.runNotFound);
      }
      case "proponi_decisione":
        return await proposeDecision(ctx, parsed.data as z.infer<typeof SCHEMAS.proponi_decisione>);
    }
  } catch (err) {
    if (err instanceof CentralinoError || err instanceof InstanceError) return toolFail(err.message);
    return toolFail(ALFRED_THREAD_MESSAGES.internal);
  }
}

// --- Contesto ------------------------------------------------------------------------------------

async function buildContext(userId: number, page: PageContext | null): Promise<string[]> {
  // Elenco senza `teamsStatus`: il contesto si costruisce a ogni turno e non deve chiamare modelli
  const teams = (await listInstances({ status: "active" })).filter((i) => i.activatedBy === userId);
  const queue = await pendingQueue(userId);
  const unread = (await unreadBulletin(userId)).length;
  const lines = [
    teams.length === 0 ? "Squadre attive: nessuna." : `Squadre attive: ${teams.length}.`,
    ...teams.slice(0, MAX_CONTEXT_TEAMS).map((t) => `#${t.id} ${t.name} · ${t.ref.title}`),
    ...(teams.length > MAX_CONTEXT_TEAMS ? [`…e altre ${teams.length - MAX_CONTEXT_TEAMS}`] : []),
    `Voci da confermare: ${queue.actions.length}.`,
    `Eventi non letti nel bollettino: ${unread}.`,
  ];
  if (page?.page === "team" && page.id !== undefined && /^[1-9][0-9]{0,9}$/.test(page.id)) {
    try {
      const team = await getInstance(Number(page.id));
      if (team.activatedBy === userId) lines.push(`Pagina: squadra ${team.name}`);
    } catch {
      // squadra inesistente: nessuna riga
    }
  }
  return [lines.join("\n")];
}

export const alfredThreadSubject: SubjectHandler = {
  character: "alfred",
  type: "alfred_thread",
  resolve: async () => ({ title: "Alfred" }),
  context: (userId, _subjectId, page) => buildContext(userId, page),
  tools: ALFRED_THREAD_TOOLS,
  runTool,
};
