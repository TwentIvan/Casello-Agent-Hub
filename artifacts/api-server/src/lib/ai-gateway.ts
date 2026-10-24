// AI Gateway - Multi-provider AI client for agent execution.
// All AI calls in this application should go through this gateway.
// No other file should instantiate a provider SDK directly - add a module
// under ./providers instead.

import OpenAI from "openai";
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

function getProviderPrefix(modelKey: string): string {
  const slashIdx = modelKey.indexOf("/");
  return slashIdx >= 0 ? modelKey.slice(0, slashIdx) : modelKey;
}

function resolveModelId(modelKey: string): string {
  const slashIdx = modelKey.indexOf("/");
  return slashIdx >= 0 ? modelKey.slice(slashIdx + 1) : modelKey;
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

  async complete(opts: GatewayCompleteOptions): Promise<GatewayCompleteResult> {
    const modelKey = opts.modelKey;
    const caller = opts.caller || "unknown";
    const startMs = Date.now();

    // Route: explicit AI_GATEWAY_BASE_URL overrides everything (LiteLLM proxy mode)
    if (process.env.AI_GATEWAY_BASE_URL) {
      const client = this.getGatewayClient();

      const params: any = {
        model: modelKey,
        messages: opts.messages,
      };
      if (opts.maxTokens) params.max_completion_tokens = opts.maxTokens;
      if (opts.temperature !== undefined) params.temperature = opts.temperature;
      // Telemetry tags for the join between transport (LiteLLM spend log) and
      // semantic (runs table) telemetry.
      params.metadata = {
        tags: [`caller:${caller}`, ...(opts.agentId !== undefined ? [`agent:${opts.agentId}`] : [])],
      };

      const response = await client.chat.completions.create(params);
      const durationMs = Date.now() - startMs;
      const promptTokens = response.usage?.prompt_tokens || 0;
      const completionTokens = response.usage?.completion_tokens || 0;
      const cachedTokens = (response.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;

      console.log(
        `[AI-GATEWAY] caller=${caller} model=${modelKey}` +
          ` prompt_tokens=${promptTokens} completion_tokens=${completionTokens}` +
          ` cached=${cachedTokens} duration=${durationMs}ms`
      );

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
