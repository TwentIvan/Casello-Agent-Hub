import { and, eq, inArray } from "drizzle-orm";
// `Server` (API di basso livello) e non `McpServer`: gli strumenti delle run hanno schemi JSON dinamici, presi
// dai tool dell'app, che `McpServer` accetterebbe solo come schemi Zod.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { db, localJobsTable, type LocalJob } from "@workspace/db";
import { logger } from "../logger";
import { claimJob, JOB_NOT_FOUND, LocalJobError, listOpenJobs, touchJob } from "./jobs";

/**
 * Server MCP di Casello per l'agente locale. Un server nuovo per ogni richiesta (trasporto senza stato), legato a
 * chi chiama: un token di lavoro (il runner, un solo lavoro) o un token personale (modalità chat: `list_jobs`,
 * `claim_job` e poi gli strumenti dei lavori presi dalla chat, con `job_id`). Gli strumenti dei lavori li
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

/** Con il token personale ogni strumento di lavoro richiede `job_id`. */
function withJobId(schema: JobToolInputSchema): JobToolInputSchema {
  return {
    ...schema,
    properties: { ...schema.properties, job_id: JOB_ID_PROPERTY },
    required: [...(schema.required ?? []).filter((r) => r !== "job_id"), "job_id"],
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
  description: "Prende un lavoro in attesa per eseguirlo in questa chat; poi usa get_job con il suo job_id.",
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

const JobIdArgs = z.object({ job_id: z.number().int().positive() });

/** Lavoro aperto preso dalla chat dall'utente indicato; null altrimenti (lavori altrui invisibili). */
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
      ),
    )
    .limit(1);
  return job ?? null;
}

async function chatJobs(userId: number): Promise<LocalJob[]> {
  return db
    .select()
    .from(localJobsTable)
    .where(and(eq(localJobsTable.userId, userId), eq(localJobsTable.claimedBy, "chat"), inArray(localJobsTable.status, CLAIMED)));
}

// --- Server --------------------------------------------------------------------------------------------------------

const result = (text: string, isError = false): CallToolResult => (isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] });

/** Esegue l'handler di uno strumento: gli errori diventano un testo fisso, mai lo stack o un indirizzo. */
async function runTool(def: JobToolDef, job: LocalJob, args: unknown): Promise<CallToolResult> {
  try {
    const out = await def.handler({ job, userId: job.userId }, args);
    return result(out.text, out.isError ?? false);
  } catch (err) {
    if (err instanceof LocalJobError) return result(err.message, true);
    logger.error({ err, tool: def.name, jobId: job.id }, "strumento MCP fallito");
    return result(TOOL_FAILED, true);
  }
}

export function createMcpServer(caller: McpCaller): Server {
  const server = new Server({ name: "casello", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (caller.kind === "job") {
      return { tools: [toTool(GET_JOB), ...(await toolsFor(caller.job)).map(toTool)] };
    }
    const tools: Tool[] = [toTool(withJobIdTool(GET_JOB)), toTool(LIST_JOBS), toTool(CLAIM_JOB)];
    const names = new Set(tools.map((t) => t.name));
    for (const job of await chatJobs(caller.userId)) {
      for (const def of await toolsFor(job)) {
        if (names.has(def.name)) continue;
        names.add(def.name);
        tools.push(toTool({ ...def, inputSchema: withJobId(def.inputSchema) }));
      }
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    const args: Record<string, unknown> = request.params.arguments ?? {};

    if (caller.kind === "job") {
      // Il lavoro è implicito nel token: un eventuale job_id non conta
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
      const parsed = JobIdArgs.safeParse(args);
      if (!parsed.success) return result(INVALID_ARGS, true);
      try {
        // Il token del lavoro non serve alla chat: si lavora con il token personale e job_id
        const { job } = await claimJob(parsed.data.job_id, { by: "chat", userId });
        await extra.sendNotification({ method: "notifications/tools/list_changed" });
        return result(`Lavoro ${job.id} (${job.kind}) preso. Chiama get_job con job_id ${job.id} per le istruzioni.`);
      } catch (err) {
        if (err instanceof LocalJobError) return result(err.message, true);
        throw err;
      }
    }

    const parsed = JobIdArgs.safeParse(args);
    const job = parsed.success ? await chatJob(userId, parsed.data.job_id) : null;
    if (!job) return result(JOB_NOT_FOUND, true);
    await touchJob(job.id);
    if (name === GET_JOB.name) return result(describeJob(job));
    const def = (await toolsFor(job)).find((t) => t.name === name);
    if (!def) return result(TOOL_UNAVAILABLE, true);
    const { job_id: _jobId, ...rest } = args;
    return runTool(def, job, rest);
  });

  return server;
}
