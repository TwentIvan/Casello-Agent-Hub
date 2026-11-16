// Turno del modello che scrive la sintesi dell'architettura: `runAgentLoop` con gli strumenti di lettura del codice
// sull'albero già raccolto e lo strumento interno `consegna_sintesi`. Una consegna valida chiude il ciclo con un
// segnale proprio (il ciclo si ferma come `cancelled` e l'esito è la sintesi consegnata). Nei log solo id, sha a 7,
// giri, token ed esito: mai sintesi, mappa o contenuti.

import type { App } from "@workspace/db";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { QUEUE_FAILED, runAgentLoop, type LoopLimits, type LoopState } from "../agent-loop";
import { CODE_TOOLS, CodeToolRunner } from "../code-reader/tools";
import { logger } from "../logger";
import { modelChatDeps, newUsage, type LoopUsage } from "../loop-wiring";
import { internalTool, type InternalToolName } from "../teams/role-tools";
import type { CatalogTool, ToolResult } from "../tools/types";
import type { Materials } from "./collect";
import { ARCH_MESSAGES } from "./messages";
import { DELIVER_TOOL_NAME, SUMMARY_MAX_CHARS, architectureMessages, scrubSummary, validateSummary } from "./prompts";

export const ARCH_UPDATE_LIMITS: LoopLimits = { maxRounds: 4, maxTokens: 60_000, maxActiveMs: 120_000 };
export const ARCH_FULL_LIMITS: LoopLimits = { maxRounds: 10, maxTokens: 150_000, maxActiveMs: 240_000 };
/** Token massimi della risposta di ogni chiamata al modello. */
export const ARCH_COMPLETION_TOKENS = 4_000;
/** Consegne non valide ammesse prima di chiudere con «sintesi non valida» (una sola correzione). */
const MAX_INVALID_DELIVERIES = 2;

export type GenerateOutcome =
  | { ok: true; summary: string; usage: LoopUsage }
  | { ok: false; error: string; usage: LoopUsage; calledModel: boolean };

export interface GenerateInput {
  app: App;
  aiModelId: number;
  userId: number;
  materials: Materials;
  signal: AbortSignal;
}

/** Schema degli strumenti del codice senza il parametro `app`: l'app è sempre quella della sintesi. */
function codeTools(): CatalogTool[] {
  return CODE_TOOLS.map((t) => {
    const params = t.function.parameters as { properties: Record<string, unknown>; required?: string[] };
    const { app: _app, ...properties } = params.properties;
    return internalTool(t.function.name as InternalToolName, t.function.description ?? "", { ...params, properties });
  });
}

function deliverTool(): CatalogTool {
  return internalTool(DELIVER_TOOL_NAME, "Consegna la sintesi dell'architettura completa, in Markdown, con le sette sezioni. Chiude il lavoro.", {
    type: "object",
    properties: { sintesi: { type: "string", maxLength: SUMMARY_MAX_CHARS, description: "Sintesi completa in Markdown" } },
    required: ["sintesi"],
  });
}

function functionTools(tools: CatalogTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.paramsSchema },
  }));
}

// Errori del ciclo che vengono dalla chiamata al modello: messaggi fissi da tenere; gli altri (limiti) = non consegnata
const MODEL_ERROR_PREFIX = "errore nella chiamata al modello";

export async function generateSummary(input: GenerateInput): Promise<GenerateOutcome> {
  const { app, materials } = input;
  const usage = newUsage();
  let calledModel = false;
  const fail = (error: string): GenerateOutcome => ({ ok: false, error, usage, calledModel });
  if (input.signal.aborted) return fail(ARCH_MESSAGES.interrupted);

  // Fine del ciclo voluta da noi (consegna valida o seconda consegna non valida)
  const done = new AbortController();
  const loopSignal = AbortSignal.any([input.signal, done.signal]);
  let delivered: string | null = null;
  let invalid = 0;

  const runner = new CodeToolRunner(input.userId, app.id);
  runner.preload(app.id, materials.source);

  const tools = [...codeTools(), deliverTool()];
  const chat = modelChatDeps({
    aiModelId: input.aiModelId,
    functionTools: functionTools(tools),
    caller: "architecture",
    usage,
    signal: input.signal,
    logContext: { appId: app.id },
    maxTokens: ARCH_COMPLETION_TOKENS,
  });

  const deliver = (args: Record<string, unknown>): ToolResult => {
    const text = typeof args["sintesi"] === "string" ? args["sintesi"].trim() : "";
    const problem = text ? validateSummary(text) : "sintesi mancante: passa il testo in «sintesi»";
    if (problem === null) {
      delivered = text;
      done.abort();
      return { ok: true, content: "Sintesi consegnata." };
    }
    invalid += 1;
    if (invalid >= MAX_INVALID_DELIVERIES) done.abort();
    return { ok: false, content: `Errore: ${problem}` };
  };

  const state: LoopState = { messages: architectureMessages(app.name, materials), queue: [], rounds: 0, tokens: 0, activeMs: 0 };
  const limits = materials.full ? ARCH_FULL_LIMITS : ARCH_UPDATE_LIMITS;
  const sha7 = materials.sha.slice(0, 7);

  try {
    const outcome = await runAgentLoop(state, {
      chat: (messages, opts) => {
        calledModel = true;
        return chat(messages, opts);
      },
      tools,
      executeTool: async (tool, args) => {
        if (tool.name === DELIVER_TOOL_NAME) return deliver(args);
        // L'app è fissata: un eventuale `app` del modello si scarta
        const { app: _ignored, ...rest } = args;
        const content = await runner.run({ id: "arch", name: tool.name, arguments: JSON.stringify(rest) });
        return { ok: !content.startsWith("Errore:"), content };
      },
      queueAction: async () => ({ ok: false, message: QUEUE_FAILED }),
      onStep: async () => {},
      limits,
      signal: loopSignal,
    });

    const tokens = usage.promptTokens + usage.completionTokens;
    const log = { appId: app.id, sha7, rounds: outcome.state.rounds, tokens, full: materials.full };
    if (delivered !== null) {
      logger.info({ ...log, outcome: "ok" }, "Sintesi dell'architettura generata");
      return { ok: true, summary: scrubSummary(delivered), usage };
    }
    let error: string;
    if (invalid >= MAX_INVALID_DELIVERIES) error = ARCH_MESSAGES.invalid;
    else if (outcome.type === "cancelled") error = ARCH_MESSAGES.interrupted;
    else if (outcome.type === "failed" && outcome.error.startsWith(MODEL_ERROR_PREFIX)) error = outcome.error;
    else error = ARCH_MESSAGES.notDelivered;
    logger.info({ ...log, outcome: "failed" }, "Sintesi dell'architettura non generata");
    return fail(error);
  } catch (err) {
    logger.error({ appId: app.id, sha7, errName: err instanceof Error ? err.name : "Error" }, "Generazione dell'architettura non riuscita");
    return fail(ARCH_MESSAGES.internal);
  }
}
