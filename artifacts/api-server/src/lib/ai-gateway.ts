// AI Gateway - Multi-provider AI client for agent execution.
// All AI calls in this application should go through this gateway.
// No other file should instantiate OpenAI or Anthropic directly.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

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

function resolveModelId(modelKey: string): string {
  const slashIdx = modelKey.indexOf("/");
  return slashIdx >= 0 ? modelKey.slice(slashIdx + 1) : modelKey;
}

function flattenContent(content: GatewayMessageContent): string {
  return Array.isArray(content) ? content.map((c) => c.text).join("\n") : content;
}

class AiGateway {
  private getOpenAIClient(baseURL?: string, apiKey?: string): OpenAI {
    return new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      ...(baseURL ? { baseURL } : {}),
    });
  }

  private getAnthropicClient(): Anthropic {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  private async completeWithAnthropic(
    opts: GatewayCompleteOptions,
    rawModelId: string,
    caller: string,
    startMs: number
  ): Promise<GatewayCompleteResult> {
    const client = this.getAnthropicClient();

    const systemParts: string[] = [];
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const msg of opts.messages) {
      if (msg.role === "system") {
        systemParts.push(flattenContent(msg.content));
      } else if (msg.role === "user" || msg.role === "assistant") {
        anthropicMessages.push({
          role: msg.role,
          content: msg.content ? flattenContent(msg.content as GatewayMessageContent) : "",
        });
      }
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: rawModelId,
      max_tokens: opts.maxTokens || 4096,
      messages: anthropicMessages,
      ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    };

    console.log(`[AI-GATEWAY] Anthropic call starting: model=${rawModelId} caller=${caller}`);
    const response = await client.messages.create(params, { timeout: 120_000 });

    const durationMs = Date.now() - startMs;
    const promptTokens = response.usage?.input_tokens || 0;
    const completionTokens = response.usage?.output_tokens || 0;
    const content = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("");

    console.log(
      `[AI-GATEWAY] caller=${caller} model=${opts.modelKey}` +
        ` prompt_tokens=${promptTokens} completion_tokens=${completionTokens} duration=${durationMs}ms`
    );

    return { content, modelKey: opts.modelKey, promptTokens, completionTokens, durationMs };
  }

  async complete(opts: GatewayCompleteOptions): Promise<GatewayCompleteResult> {
    const modelKey = opts.modelKey;
    const caller = opts.caller || "unknown";
    const startMs = Date.now();

    // Route: explicit AI_GATEWAY_BASE_URL overrides everything (LiteLLM proxy mode)
    if (process.env.AI_GATEWAY_BASE_URL) {
      const client = this.getOpenAIClient(
        process.env.AI_GATEWAY_BASE_URL,
        process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY
      );

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

    // Route by provider prefix (direct call — rollback path if the proxy is down)
    if (modelKey.startsWith("openai/")) {
      const client = this.getOpenAIClient();
      const rawModelId = resolveModelId(modelKey);

      const params: any = {
        model: rawModelId,
        messages: opts.messages,
      };
      if (opts.maxTokens) params.max_completion_tokens = opts.maxTokens;
      if (opts.temperature !== undefined) params.temperature = opts.temperature;

      const response = await client.chat.completions.create(params);
      const durationMs = Date.now() - startMs;
      const promptTokens = response.usage?.prompt_tokens || 0;
      const completionTokens = response.usage?.completion_tokens || 0;

      console.log(
        `[AI-GATEWAY] caller=${caller} model=${modelKey}` +
          ` prompt_tokens=${promptTokens} completion_tokens=${completionTokens} duration=${durationMs}ms`
      );

      return {
        content: response.choices[0]?.message?.content || "",
        modelKey,
        promptTokens,
        completionTokens,
        durationMs,
      };
    }

    if (modelKey.startsWith("anthropic/")) {
      const rawModelId = resolveModelId(modelKey);
      return this.completeWithAnthropic(opts, rawModelId, caller, startMs);
    }

    throw new Error(
      `[AI-GATEWAY] Cannot route model "${modelKey}": unknown provider. Supported prefixes: openai/, anthropic/. For altri provider, imposta AI_GATEWAY_BASE_URL.`
    );
  }
}

export const aiGateway = new AiGateway();
