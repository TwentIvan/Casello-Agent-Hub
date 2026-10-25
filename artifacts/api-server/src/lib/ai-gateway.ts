// AI Gateway - Multi-provider AI client for agent execution.
// All AI calls in this application should go through this gateway.
// No other file should instantiate a provider SDK directly - add a module
// under ./providers instead.

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { directProviders } from "./providers";
import { DEFAULT_MODEL } from "./models";

export type GatewayMessageContent =
  | string
  | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;

export type GatewayMessage =
  | { role: "system" | "user"; content: GatewayMessageContent }
  | { role: "assistant"; content?: string | null };

export interface GatewayCompleteOptions {
  modelKey: string;
  messages: GatewayMessage[];
  maxTokens?: number;
  temperature?: number;
  agentId?: number;
  /** Identifies the calling service in logs (e.g. "run-executor") */
  caller?: string;
}

export interface GatewayCompleteResult {
  content: string;
  modelKey: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

export interface GatewayChatOptions {
  modelKey: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  maxTokens?: number;
  temperature?: number;
  agentId?: number;
  /** Identifies the calling service in logs (e.g. "run-executor") */
  caller?: string;
  signal?: AbortSignal;
}

export interface ChatToolCall {
  id: string;
  name: string;
  /** Argomenti come stringa JSON, così come li ha prodotti il modello (non validata) */
  arguments: string;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
}

// Chiamate con function calling (run degli agenti): un nuovo tentativo al massimo e un tetto di
// tempo per singola richiesta. Il tempo del turno lo limita il signal passato da run-executor.
const CHAT_MAX_RETRIES = 1;
const CHAT_REQUEST_TIMEOUT_MS = 120_000;

function getProviderPrefix(modelKey: string): string {
  const slashIdx = modelKey.indexOf("/");
  return slashIdx >= 0 ? modelKey.slice(0, slashIdx) : modelKey;
}

function resolveModelId(modelKey: string): string {
  const slashIdx = modelKey.indexOf("/");
  return slashIdx >= 0 ? modelKey.slice(slashIdx + 1) : modelKey;
}

// Telemetry tags for the join between transport (LiteLLM spend log) and
// semantic (runs table) telemetry.
function buildTelemetryMetadata(caller: string, agentId: number | undefined): { tags: string[] } {
  return { tags: [`caller:${caller}`, ...(agentId !== undefined ? [`agent:${agentId}`] : [])] };
}

function buildProxyParams(
  base: { model: string; messages: ChatCompletionMessageParam[] },
  opts: { maxTokens?: number; temperature?: number; agentId?: number },
  caller: string,
): ChatCompletionCreateParamsNonStreaming {
  const params: ChatCompletionCreateParamsNonStreaming = { ...base };
  if (opts.maxTokens) params.max_completion_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) params.temperature = opts.temperature;
  // `metadata` è un'estensione LiteLLM: nel tipo OpenAI ha un'altra forma.
  (params as { metadata?: unknown }).metadata = buildTelemetryMetadata(caller, opts.agentId);
  return params;
}

function readUsage(response: ChatCompletion): { promptTokens: number; completionTokens: number; cachedTokens: number } {
  return {
    promptTokens: response.usage?.prompt_tokens || 0,
    completionTokens: response.usage?.completion_tokens || 0,
    cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function logProxyUsage(
  caller: string,
  modelKey: string,
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
  durationMs: number,
): void {
  console.log(
    `[AI-GATEWAY] caller=${caller} model=${modelKey}` +
      ` prompt_tokens=${usage.promptTokens} completion_tokens=${usage.completionTokens}` +
      ` cached=${usage.cachedTokens} duration=${durationMs}ms`
  );
}

class AiGateway {
  // LiteLLM espone un'API compatibile OpenAI: l'SDK openai fa solo da trasporto.
  private getGatewayClient(): OpenAI {
    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      throw new Error("[AI-GATEWAY] AI_GATEWAY_BASE_URL è impostata ma manca AI_GATEWAY_API_KEY (chiave virtuale LiteLLM).");
    }
    return new OpenAI({ apiKey, baseURL: process.env.AI_GATEWAY_BASE_URL });
  }

  // Chiamata con function calling (OpenAI-style) via proxy LiteLLM. Senza proxy
  // supporta solo il testo semplice, delegando a `complete`.
  async chat(opts: GatewayChatOptions): Promise<ChatResult> {
    const modelKey = opts.modelKey;
    const caller = opts.caller || "unknown";
    const tools = opts.tools ?? [];

    if (!process.env.AI_GATEWAY_BASE_URL) {
      if (tools.length > 0) {
        throw new Error("i tool richiedono il gateway LiteLLM (AI_GATEWAY_BASE_URL)");
      }
      const messages: GatewayMessage[] = opts.messages.map((m) => {
        if (
          (m.role === "system" || m.role === "user" || m.role === "assistant") &&
          (typeof m.content === "string" || (m.role === "assistant" && m.content == null)) &&
          !(m.role === "assistant" && m.tool_calls?.length)
        ) {
          return { role: m.role, content: m.content as string } as GatewayMessage;
        }
        throw new Error(
          "[AI-GATEWAY] Senza AI_GATEWAY_BASE_URL sono supportati solo messaggi di testo semplice (system, user, assistant).",
        );
      });
      opts.signal?.throwIfAborted();
      const result = await this.complete({
        modelKey,
        messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        agentId: opts.agentId,
        caller,
      });
      return {
        content: result.content,
        toolCalls: [],
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      };
    }

    const client = this.getGatewayClient();
    const startMs = Date.now();
    const params = buildProxyParams({ model: modelKey, messages: opts.messages }, opts, caller);
    if (tools.length > 0) {
      params.tools = tools;
      params.tool_choice = "auto";
    }

    const response = await client.chat.completions.create(params, {
      signal: opts.signal,
      maxRetries: CHAT_MAX_RETRIES,
      timeout: CHAT_REQUEST_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startMs;
    const { promptTokens, completionTokens, cachedTokens } = readUsage(response);
    // I contenuti dei messaggi non finiscono mai nei log.
    logProxyUsage(caller, modelKey, { promptTokens, completionTokens, cachedTokens }, durationMs);

    const message = response.choices[0]?.message;
    const toolCalls: ChatToolCall[] = [];
    for (const call of message?.tool_calls ?? []) {
      if (call.type === "function") {
        toolCalls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
    return { content: message?.content ?? null, toolCalls, promptTokens, completionTokens };
  }

  async complete(opts: GatewayCompleteOptions): Promise<GatewayCompleteResult> {
    const modelKey = opts.modelKey;
    const caller = opts.caller || "unknown";
    const startMs = Date.now();

    // Route: explicit AI_GATEWAY_BASE_URL overrides everything (LiteLLM proxy mode)
    if (process.env.AI_GATEWAY_BASE_URL) {
      const client = this.getGatewayClient();

      const params = buildProxyParams(
        { model: modelKey, messages: opts.messages as ChatCompletionMessageParam[] },
        opts,
        caller,
      );

      const response = await client.chat.completions.create(params);
      const durationMs = Date.now() - startMs;
      const usage = readUsage(response);
      const { promptTokens, completionTokens } = usage;
      logProxyUsage(caller, modelKey, usage, durationMs);

      return {
        content: response.choices[0]?.message?.content || "",
        modelKey,
        promptTokens,
        completionTokens,
        durationMs,
      };
    }

    // Direct mode (no proxy) — rollback path if the gateway deploy is off.
    // Resolve which provider module handles this request, falling back to a
    // configured default model when the requested one has no direct module.
    let effectiveModelKey = modelKey;
    let provider = getProviderPrefix(effectiveModelKey);

    if (!directProviders[provider]) {
      const fallbackModelKey = process.env.AI_GATEWAY_FALLBACK_MODEL || DEFAULT_MODEL;
      const fallbackProvider = getProviderPrefix(fallbackModelKey);
      if (!directProviders[fallbackProvider]) {
        throw new Error(
          `[AI-GATEWAY] Nessun modulo diretto per il provider "${provider}" (model="${modelKey}"), e il ` +
            `fallback configurato ("${fallbackModelKey}") non è supportato nemmeno lui. Provider diretti ` +
            `disponibili: ${Object.keys(directProviders).join(", ")}. Per usare "${provider}" senza scrivere ` +
            `un modulo dedicato, imposta AI_GATEWAY_BASE_URL (modalità proxy).`
        );
      }
      console.warn(
        `[AI-GATEWAY] Provider "${provider}" non ha un modulo diretto (proxy spento). ` +
          `Fallback su "${fallbackModelKey}" per questa chiamata (caller=${caller}).`
      );
      effectiveModelKey = fallbackModelKey;
      provider = fallbackProvider;
    }

    const rawModelId = resolveModelId(effectiveModelKey);
    const result = await directProviders[provider]({
      rawModelId,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      caller,
    });
    const durationMs = Date.now() - startMs;

    console.log(
      `[AI-GATEWAY] caller=${caller} model=${effectiveModelKey}` +
        (effectiveModelKey !== modelKey ? ` (fallback da ${modelKey})` : "") +
        ` prompt_tokens=${result.promptTokens} completion_tokens=${result.completionTokens} duration=${durationMs}ms`
    );

    return {
      content: result.content,
      modelKey: effectiveModelKey,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs,
    };
  }
}

export const aiGateway = new AiGateway();
