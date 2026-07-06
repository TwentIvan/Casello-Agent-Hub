import Anthropic from "@anthropic-ai/sdk";
import type { GatewayMessageContent } from "../ai-gateway";
import type { ProviderCompleteArgs, ProviderCompleteResult, ProviderHandler } from "./types";

function flattenContent(content: GatewayMessageContent): string {
  return Array.isArray(content) ? content.map((c) => c.text).join("\n") : content;
}

export const completeWithAnthropic: ProviderHandler = async ({
  rawModelId,
  messages,
  maxTokens,
  caller,
}: ProviderCompleteArgs): Promise<ProviderCompleteResult> => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemParts: string[] = [];
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
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
    max_tokens: maxTokens || 4096,
    messages: anthropicMessages,
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
  };

  console.log(`[AI-GATEWAY] Anthropic call starting: model=${rawModelId} caller=${caller}`);
  const response = await client.messages.create(params, { timeout: 120_000 });

  const content = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  return {
    content,
    promptTokens: response.usage?.input_tokens || 0,
    completionTokens: response.usage?.output_tokens || 0,
  };
};
