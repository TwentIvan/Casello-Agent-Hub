import { and, eq, gt, inArray } from "drizzle-orm";
// `Server` (API di basso livello) e non `McpServer`: gli strumenti delle run hanno schemi JSON dinamici, presi
// dai tool dell'app, che `McpServer` accetterebbe solo come schemi Zod.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ServerNotification,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { db, localJobsTable, type LocalJob } from "@workspace/db";
import { logger } from "../logger";
import { claimJob, JOB_NOT_FOUND, LocalJobError, listOpenJobs, touchJob } from "./jobs";

/**
 * Server MCP di Casello per l'agente locale. Un server nuovo per ogni richiesta (trasporto senza stato), legato a
 * chi chiama: un token di lavoro (il runner, un solo lavoro) o un token personale (modalità chat: `list_jobs`,
 * `claim_job` e poi gli strumenti dei lavori presi dalla chat, con `casello_job_id`). Gli strumenti dei lavori li
 * registrano i Task delle analisi e delle run, per tipo di lavoro.
 */

type JobKind = LocalJob["kind"];

export type JobToolContext = { job: LocalJob; userId: number };
export type JobToolResult = { text: string; isError?: boolean };
export type JobToolHandler = (ctx: JobToolContext, args: unknown) => Promise<JobToolResult>;
/** Schema JSON degli argomenti (oggetto); l'handler valida da sé gli argomenti ricevuti. */
export type JobToolInputSchema = { type: "object"; properties?: Record<string, object>; required?: string[]; [key: string]: unknown };
export type JobToolDef = { name: string; description: string; inputSchema: JobToolInputSchema; handler: JobToolHandler };
export type JobToolProvider = (ctx: JobToolContext) => Promise<JobToolDef[]>;

/** Chi chiama il server MCP, già autenticato dalla route. */
export type McpCaller = { kind: "job"; job: LocalJob } | { kind: "personal"; userId: number };

const TOOL_UNAVAILABLE = "strumento non disponibile";
const TOOL_FAILED = "errore interno dello strumento";
const INVALID_ARGS = "argomenti non validi";

// Lavori aperti e già presi (gli unici su cui lavorano gli strumenti)
const CLAIMED: LocalJob["status"][] = ["claimed", "running", "paused"];
const UNCLAIMED: LocalJob["status"][] = ["queued", "waiting_choice", "postponed"];

const LIMITS: Record<JobKind, string> = {
  analysis:
    "Usa solo gli strumenti di Casello: il codice dell'app si legge solo da questi. Massimo 300 richieste al minuto; il lavoro scade se resta inattivo.",
  run: "Usa solo gli strumenti di Casello: i tool dell'app li esegue Casello, con le sue conferme e i suoi limiti. Massimo 300 richieste al minuto; il lavoro scade se resta inattivo.",
};

const BUILTIN = ["get_job", "list_jobs", "claim_job"];

// --- Registro degli strumenti dei lavori ----------------------------------------------------------------------------

const staticTools: Record<JobKind, Map<string, JobToolDef>> = { analysis: new Map(), run: new Map() };
const providers: Record<JobKind, Set<JobToolProvider>> = { analysis: new Set(), run: new Set() };

/** Strumento fisso per un tipo di lavoro; restituisce la funzione che lo toglie (per i test). */
export function registerJobTool(kind: JobKind, def: JobToolDef): () => void {
  if (BUILTIN.includes(def.name) || staticTools[kind].has(def.name)) throw new Error(`strumento MCP già registrato: ${def.name}`);
  staticTools[kind].set(def.name, def);
  return () => {
    if (staticTools[kind].get(def.name) === def) staticTools[kind].delete(def.name);
  };
}

/** Strumenti che dipendono dal lavoro (es. i tool dell'app di una run); restituisce la funzione che lo toglie. */
export function registerJobToolProvider(kind: JobKind, provider: JobToolProvider): () => void {
  providers[kind].add(provider);
  return () => {
    providers[kind].delete(provider);
  };
}

/** Strumenti di un lavoro: i fissi del suo tipo, poi quelli dinamici (a parità di nome vince il primo). */
async function toolsFor(job: LocalJob): Promise<JobToolDef[]> {
  const ctx = { job, userId: job.userId };
  const all = [...staticTools[job.kind].values()];
  for (const provider of providers[job.kind]) all.push(...(await provider(ctx)));
  const seen = new Set<string>(BUILTIN);
  return all.filter((t) => !seen.has(t.name) && (seen.add(t.name), true));
}

// --- Strumenti predefiniti ------------------------------------------------------------------------------------------

const JOB_ID_PROPERTY = { type: "integer", minimum: 1, description: "Id del lavoro preso con claim_job" };
// Argomento che sceglie il lavoro con il token personale: un nome che non si scontra con i parametri dei tool
// dell'app (che possono avere un loro `job_id`)
const JOB_ARG = "casello_job_id";

/** Con il token personale ogni strumento di lavoro (anche `get_job`) richiede `casello_job_id`. */
function withJobId(schema: JobToolInputSchema): JobToolInputSchema {
  return {
    ...schema,
    properties: { ...schema.properties, [JOB_ARG]: JOB_ID_PROPERTY },
    required: [...(schema.required ?? []).filter((r) => r !== JOB_ARG), JOB_ARG],
  };
}

function withJobIdTool<T extends { inputSchema: JobToolInputSchema }>(def: T): T {
  return { ...def, inputSchema: withJobId(def.inputSchema) };
}

function toTool(def: Pick<JobToolDef, "name" | "description" | "inputSchema">): Tool {
  return { name: def.name, description: def.description, inputSchema: def.inputSchema };
}

const GET_JOB = {
  name: "get_job",
  description: "Istruzioni del compito corrente del lavoro: prompt da eseguire, tipo di lavoro e limiti.",
  inputSchema: { type: "object", properties: {} } as JobToolInputSchema,
};
const LIST_JOBS = {
  name: "list_jobs",
  description: "I tuoi lavori dell'agente locale in attesa (in coda, posticipati o in attesa di una scelta).",
  inputSchema: { type: "object", properties: {} } as JobToolInputSchema,
};
const CLAIM_JOB = {
  name: "claim_job",
  description: "Prende un lavoro in attesa per eseguirlo in questa chat; poi usa get_job con casello_job_id uguale al suo id.",
  inputSchema: { type: "object", properties: { job_id: JOB_ID_PROPERTY }, required: ["job_id"] } as JobToolInputSchema,
};

function describeJob(job: LocalJob): string {
  const item = job.currentItem;
  return JSON.stringify({
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    itemId: item?.id ?? null,
    prompt: item?.prompt ?? null,
    limits: LIMITS[job.kind],
  });
}

const JobId = z.number().int().positive();
const ClaimArgs = z.object({ job_id: JobId });
const JobArgs = z.object({ [JOB_ARG]: JobId });

/**
 * Lavoro aperto preso dalla chat dall'utente indicato, con il token non scaduto (un lavoro scaduto ma non ancora
 * chiuso da `expireLocalJobs` non torna in vita con `touchJob`); null altrimenti (lavori altrui invisibili).
 */
async function chatJob(userId: number, jobId: number): Promise<LocalJob | null> {
  const [job] = await db
    .select()
    .from(localJobsTable)
    .where(
      and(
        eq(localJobsTable.id, jobId),
        eq(localJobsTable.userId, userId),
        eq(localJobsTable.claimedBy, "chat"),
        inArray(localJobsTable.status, CLAIMED),
        gt(localJobsTable.jobTokenExpiresAt, new Date()),
      ),
    )
    .limit(1);
  return job ?? null;
}

async function chatJobs(userId: number): Promise<LocalJob[]> {
  return db
    .select()
    .from(localJobsTable)
    .where(
      and(
        eq(localJobsTable.userId, userId),
        eq(localJobsTable.claimedBy, "chat"),
        inArray(localJobsTable.status, CLAIMED),
        gt(localJobsTable.jobTokenExpiresAt, new Date()),
      ),
    );
}

// --- Server --------------------------------------------------------------------------------------------------------

const result = (text: string, isError = false): CallToolResult => (isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] });

/** Nel log solo il nome dell'errore: il messaggio può contenere indirizzi, SQL o dati dell'app. */
function logFailure(err: unknown, what: string, extra: Record<string, unknown> = {}): void {
  logger.error({ ...extra, errName: err instanceof Error ? err.name : typeof err }, what);
}

type SendNotification = (notification: ServerNotification) => Promise<void>;

/** Strumenti elencati per chi chiama: con il token personale anche quelli dei lavori presi dalla chat. */
async function listTools(caller: McpCaller): Promise<Tool[]> {
  if (caller.kind === "job") return [toTool(GET_JOB), ...(await toolsFor(caller.job)).map(toTool)];
  const tools: Tool[] = [toTool(withJobIdTool(GET_JOB)), toTool(LIST_JOBS), toTool(CLAIM_JOB)];
  const names = new Set(tools.map((t) => t.name));
  for (const job of await chatJobs(caller.userId)) {
    for (const def of await toolsFor(job)) {
      if (names.has(def.name)) continue;
      names.add(def.name);
      tools.push(toTool({ ...def, inputSchema: withJobId(def.inputSchema) }));
    }
  }
  return tools;
}

async function callTool(caller: McpCaller, name: string, args: Record<string, unknown>, sendNotification: SendNotification): Promise<CallToolResult> {
  if (caller.kind === "job") {
    // Il lavoro è implicito nel token: un eventuale casello_job_id non conta
    if (name === GET_JOB.name) return result(describeJob(caller.job));
    const def = (await toolsFor(caller.job)).find((t) => t.name === name);
    return def ? runTool(def, caller.job, args) : result(TOOL_UNAVAILABLE, true);
  }

  const userId = caller.userId;
  if (name === LIST_JOBS.name) {
    const open = (await listOpenJobs(userId)).filter((j) => UNCLAIMED.includes(j.status));
    return result(JSON.stringify(open.map((j) => ({ id: j.id, kind: j.kind, status: j.status, origin: j.origin, createdAt: j.createdAt }))));
  }
  if (name === CLAIM_JOB.name) {
    const parsed = ClaimArgs.safeParse(args);
    if (!parsed.success) return result(INVALID_ARGS, true);
    // Il token del lavoro non serve alla chat: si lavora con il token personale e casello_job_id
    const { job } = await claimJob(parsed.data.job_id, { by: "chat", userId });
    await sendNotification({ method: "notifications/tools/list_changed" });
    return result(`Lavoro ${job.id} (${job.kind}) preso. Chiama get_job con casello_job_id ${job.id} per le istruzioni.`);
  }

  const parsed = JobArgs.safeParse(args);
  const job = parsed.success ? await chatJob(userId, parsed.data[JOB_ARG]) : null;
  if (!job) return result(JOB_NOT_FOUND, true);
  await touchJob(job.id);
  if (name === GET_JOB.name) return result(describeJob(job));
  const def = (await toolsFor(job)).find((t) => t.name === name);
  if (!def) return result(TOOL_UNAVAILABLE, true);
  const { [JOB_ARG]: _jobId, ...rest } = args;
  return runTool(def, job, rest);
}

async function runTool(def: JobToolDef, job: LocalJob, args: unknown): Promise<CallToolResult> {
  const out = await def.handler({ job, userId: job.userId }, args);
  return result(out.text, out.isError ?? false);
}

/**
 * Ogni errore (strumenti, provider, DB) diventa un testo fisso, mai lo stack, un indirizzo o SQL: `LocalJobError`
 * porta il suo messaggio (fisso, in italiano), il resto "errore interno dello strumento".
 */
export function createMcpServer(caller: McpCaller): Server {
  const server = new Server({ name: "casello", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return { tools: await listTools(caller) };
    } catch (err) {
      logFailure(err, "elenco degli strumenti MCP fallito");
      throw new McpError(ErrorCode.InternalError, err instanceof LocalJobError ? err.message : TOOL_FAILED);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    try {
      return await callTool(caller, name, request.params.arguments ?? {}, extra.sendNotification);
    } catch (err) {
      if (err instanceof LocalJobError) return result(err.message, true);
      logFailure(err, "strumento MCP fallito", { tool: name });
      return result(TOOL_FAILED, true);
    }
  });

  return server;
}
