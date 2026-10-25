import { db, agentsTable, appsTable, runsTable, runStepsTable, type Agent, type App, type Run } from "@workspace/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { aiGateway } from "./ai-gateway";
import {
  PendingMismatchError,
  resolvePending,
  runAgentLoop,
  type LoopDeps,
  type LoopState,
  type PendingAction,
  type StepRecord,
} from "./agent-loop";
import { logger } from "./logger";
import { loadAgentTools, loadAppConnection, maskSensitiveArgs, toFunctionTools } from "./tools/catalog";
import { executeTool } from "./tools/executor";
import type { AppConnection, CatalogTool, ToolResult } from "./tools/types";
import { PAUSE_TTL_MS, clearUserToken, getUserToken, setUserToken } from "./user-tokens";

// Orchestrazione delle run: collega il ciclo dell'agente (puro) al DB, all'esecutore HTTP dei
// tool e al gateway dei modelli. Ogni passo diventa una riga di `run_steps`; a ogni pausa lo
// stato del ciclo viene salvato nella run e ripreso da `resumeRun`.
// Il token dell'utente vive solo in memoria (user-tokens.ts): mai nel DB né nei log.

const EXECUTOR_INSTRUCTION =
  "Sei l'esecutore di un agente configurato nell'hub Casello. Usa il contesto fornito per rispondere in modo pertinente al task richiesto. Rispondi in italiano.";

export const REJECTED_ACTION_MESSAGE = "L'utente ha annullato l'azione.";
export const PAUSE_EXPIRED_MESSAGE = "Conferma non arrivata entro 10 minuti.";

/** La run non è (più) in attesa di conferma: già ripresa, scaduta, annullata o mai in pausa. */
export class ResumeConflictError extends Error {
  constructor(message = "La run non è in attesa di conferma: è già stata ripresa, è scaduta o non è in pausa.") {
    super(message);
    this.name = "ResumeConflictError";
  }
}

interface RunContext {
  run: Run;
  agent: Agent;
  tools: CatalogTool[];
  conn: AppConnection;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Contesto di sistema: app e istruzioni dell'agente. I tool non sono elencati nel testo:
// arrivano al modello come function calling.
function buildSystemPrompt(agent: Agent, app: App): string {
  const context = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `🤖 CONTESTO AGENTE: ${agent.name}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `App: ${app.name} (${app.baseUrl})`,
    app.description ?? "",
    "",
    "Istruzioni agente:",
    agent.systemPrompt || "(nessuna istruzione specifica)",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return `${EXECUTOR_INSTRUCTION}\n\n${context}`;
}

async function loadContext(run: Run): Promise<RunContext & { app: App }> {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, run.agentId)).limit(1);
  if (!agent) throw new Error(`agente ${run.agentId} non trovato`);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, agent.appId)).limit(1);
  if (!app) throw new Error(`app ${agent.appId} non trovata`);
  const [tools, conn] = await Promise.all([loadAgentTools(agent.id), loadAppConnection(app.id)]);
  return { run, agent, app, tools, conn };
}

async function nextPosition(runId: number): Promise<number> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${runStepsTable.position}), -1) + 1` })
    .from(runStepsTable)
    .where(eq(runStepsTable.runId, runId));
  return Number(row?.next ?? 0);
}

/** Scrive i passi della run con posizioni crescenti, oscurando gli argomenti sensibili. */
function stepWriter(runId: number, startPosition: number, tools: CatalogTool[]) {
  let position = startPosition;
  return async (step: StepRecord): Promise<void> => {
    const tool = step.toolName ? tools.find((t) => t.name === step.toolName) : undefined;
    const args = step.args === undefined ? null : tool ? maskSensitiveArgs(tool, step.args) : step.args;
    await db.insert(runStepsTable).values({
      runId,
      position: position++,
      type: step.type,
      toolName: step.toolName ?? null,
      args,
      ok: step.ok,
      httpStatus: step.httpStatus ?? null,
      durationMs: Math.round(step.durationMs),
      error: step.error ?? null,
    });
  };
}

function runTool(ctx: RunContext, tool: CatalogTool, args: Record<string, unknown>): Promise<ToolResult> {
  return executeTool({ conn: ctx.conn, tool, args, userToken: getUserToken(ctx.run.id) });
}

/**
 * Esegue il ciclo dell'agente dallo stato dato e salva l'esito nella run.
 * Token e durata si sommano a quelli già registrati (la run può attraversare più pause).
 */
async function driveLoop(
  ctx: RunContext,
  state: LoopState,
  segmentStart: number,
  writeStep: (step: StepRecord) => Promise<void>,
): Promise<void> {
  const runId = ctx.run.id;
  let promptTokens = 0;
  let completionTokens = 0;
  const functionTools = toFunctionTools(ctx.tools);

  const deps: LoopDeps = {
    chat: async (messages) => {
      const reply = await aiGateway.chat({
        modelKey: ctx.agent.model,
        messages,
        tools: functionTools,
        agentId: ctx.agent.id,
        caller: "run-executor",
        maxTokens: 2000,
        temperature: 0.3,
      });
      promptTokens += reply.promptTokens;
      completionTokens += reply.completionTokens;
      return reply;
    },
    tools: ctx.tools,
    executeTool: (tool, args) => runTool(ctx, tool, args),
    onStep: writeStep,
  };

  const outcome = await runAgentLoop(state, deps);

  const totals = {
    promptTokens: (ctx.run.promptTokens ?? 0) + promptTokens,
    completionTokens: (ctx.run.completionTokens ?? 0) + completionTokens,
    durationMs: (ctx.run.durationMs ?? 0) + (Date.now() - segmentStart),
  };

  switch (outcome.type) {
    case "paused": {
      await db
        .update(runsTable)
        .set({
          ...totals,
          status: "awaiting_client",
          loopState: outcome.state,
          pendingAction: outcome.pending,
          pausedAt: new Date(),
        })
        .where(eq(runsTable.id, runId));
      // La scadenza del token riparte dall'inizio della pausa
      const token = getUserToken(runId);
      if (token) setUserToken(runId, token);
      return;
    }
    case "finished":
      await db
        .update(runsTable)
        .set({
          ...totals,
          status: "succeeded",
          output: outcome.content,
          loopState: null,
          pendingAction: null,
          pausedAt: null,
          finishedAt: new Date(),
        })
        .where(eq(runsTable.id, runId));
      clearUserToken(runId);
      return;
    case "failed":
      await db
        .update(runsTable)
        .set({
          ...totals,
          status: "failed",
          errorMessage: outcome.error,
          loopState: null,
          pendingAction: null,
          pausedAt: null,
          finishedAt: new Date(),
        })
        .where(eq(runsTable.id, runId));
      clearUserToken(runId);
      return;
  }
}

/** Chiude la run come fallita dopo un errore inatteso; non lancia. Il token non finisce nei log. */
async function failRun(runId: number, err: unknown, durationMs: number): Promise<void> {
  clearUserToken(runId);
  const message = errorMessage(err);
  logger.error({ runId, error: message }, "Run fallita per un errore inatteso");
  try {
    await db
      .update(runsTable)
      .set({
        status: "failed",
        errorMessage: `Errore durante l'esecuzione: ${message}`,
        loopState: null,
        pendingAction: null,
        pausedAt: null,
        durationMs,
        finishedAt: new Date(),
      })
      .where(eq(runsTable.id, runId));
  } catch (dbErr) {
    logger.error({ runId, error: errorMessage(dbErr) }, "Impossibile chiudere la run fallita");
  }
}

/**
 * Avvia una run in stato `pending`: la porta a `running` ed esegue il ciclo dell'agente fino
 * alla fine, a un errore o a una pausa (`awaiting_client`). Gli errori inattesi chiudono la run
 * come `failed`; lancia solo se la run non esiste o non è `pending`.
 */
export async function startRun(runId: number, opts: { userToken?: string } = {}): Promise<void> {
  const [run] = await db
    .update(runsTable)
    .set({ status: "running" })
    .where(and(eq(runsTable.id, runId), eq(runsTable.status, "pending")))
    .returning();
  if (!run) throw new Error(`La run ${runId} non esiste o non è in attesa di avvio`);

  if (opts.userToken) setUserToken(runId, opts.userToken);
  const segmentStart = Date.now();
  try {
    const ctx = await loadContext(run);
    const initial: LoopState = {
      messages: [
        { role: "system", content: buildSystemPrompt(ctx.agent, ctx.app) },
        { role: "user", content: run.input ?? "" },
      ],
      queue: [],
      rounds: 0,
      tokens: 0,
      activeMs: 0,
    };
    await driveLoop(ctx, initial, segmentStart, stepWriter(runId, await nextPosition(runId), ctx.tools));
  } catch (err) {
    await failRun(runId, err, (run.durationMs ?? 0) + (Date.now() - segmentStart));
  }
}

function isLoopState(value: unknown): value is LoopState {
  const v = value as LoopState | null;
  return !!v && typeof v === "object" && Array.isArray(v.messages) && Array.isArray(v.queue);
}

function isPendingAction(value: unknown): value is PendingAction {
  const v = value as PendingAction | null;
  return !!v && typeof v === "object" && typeof v.toolCallId === "string" && typeof v.toolName === "string";
}

/**
 * Riprende una run in pausa con la decisione dell'utente. La transizione
 * `awaiting_client → running` è un UPDATE condizionato: una seconda chiamata (anche concorrente)
 * o una pausa scaduta non trovano righe e lanciano `ResumeConflictError`, senza eseguire il tool.
 */
export async function resumeRun(
  runId: number,
  decision: "approved" | "rejected",
  opts: { userToken?: string } = {},
): Promise<void> {
  const cutoff = new Date(Date.now() - PAUSE_TTL_MS);
  const [run] = await db
    .update(runsTable)
    .set({ status: "running" })
    .where(
      and(eq(runsTable.id, runId), eq(runsTable.status, "awaiting_client"), gte(runsTable.pausedAt, cutoff)),
    )
    .returning();
  if (!run) throw new ResumeConflictError();

  if (opts.userToken) {
    setUserToken(runId, opts.userToken);
  } else {
    const token = getUserToken(runId);
    if (token) setUserToken(runId, token);
  }

  const segmentStart = Date.now();
  const elapsed = () => (run.durationMs ?? 0) + (Date.now() - segmentStart);
  try {
    const state = run.loopState;
    const pending = run.pendingAction;
    if (!isLoopState(state) || !isPendingAction(pending)) {
      throw new Error("stato della pausa mancante o non valido");
    }
    // Verifica che l'azione sia davvero quella in attesa PRIMA di eseguire il tool
    resolvePending(state, pending, { ok: false, content: "" });

    const ctx = await loadContext(run);
    const writeStep = stepWriter(runId, await nextPosition(runId), ctx.tools);

    let result: ToolResult;
    let durationMs = 0;
    if (decision === "approved") {
      // Il tool deve essere ancora attivo e visibile all'agente
      const tool = ctx.tools.find((t) => t.name === pending.toolName);
      if (!tool) {
        result = { ok: false, content: `Errore: lo strumento "${pending.toolName}" non è più disponibile` };
      } else {
        const t0 = Date.now();
        result = await runTool(ctx, tool, pending.args);
        durationMs = Date.now() - t0;
      }
    } else {
      result = { ok: false, content: REJECTED_ACTION_MESSAGE };
    }

    // resolvePending non registra passi: il passo `tool` della chiamata confermata/rifiutata va scritto qui
    await writeStep({
      type: "tool",
      toolName: pending.toolName,
      args: pending.args,
      ok: result.ok,
      httpStatus: result.status,
      durationMs,
      error: result.ok ? undefined : result.content,
    });

    await driveLoop(ctx, resolvePending(state, pending, result), segmentStart, writeStep);
  } catch (err) {
    await failRun(runId, err, elapsed());
    if (err instanceof PendingMismatchError) {
      throw new ResumeConflictError(`La run non può essere ripresa: ${err.message}`);
    }
  }
}

/** Chiude come `cancelled` le run in pausa da più di PAUSE_TTL_MS. Restituisce quante ne ha chiuse. */
export async function expireStalePausedRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PAUSE_TTL_MS);
  const expired = await db
    .update(runsTable)
    .set({
      status: "cancelled",
      errorMessage: PAUSE_EXPIRED_MESSAGE,
      loopState: null,
      finishedAt: now,
    })
    .where(and(eq(runsTable.status, "awaiting_client"), lt(runsTable.pausedAt, cutoff)))
    .returning({ id: runsTable.id });
  for (const { id } of expired) clearUserToken(id);
  return expired.length;
}

/**
 * Le run girano nel processo dell'API: se il processo si riavvia (deploy, crash) quelle in corso non
 * finiranno mai. All'avvio si chiudono come fallite, così la UI non le mostra "in corso" per sempre.
 */
export async function failInterruptedRuns(): Promise<number> {
  const interrupted = await db
    .update(runsTable)
    .set({
      status: "failed",
      errorMessage: "Esecuzione interrotta dal riavvio del server.",
      finishedAt: new Date(),
    })
    .where(inArray(runsTable.status, ["pending", "running"]))
    .returning({ id: runsTable.id });
  return interrupted.length;
}

/**
 * Compatibilità temporanea per `routes/agents.ts` (migrata nel Task 9): avvia la run senza token
 * utente. Da rimuovere quando le route useranno `startRun`.
 */
export function executeRun(runId: number): Promise<void> {
  return startRun(runId);
}
