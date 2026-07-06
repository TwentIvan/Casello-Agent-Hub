import OpenAI from "openai";
import type { ProviderCompleteArgs, ProviderCompleteResult, ProviderHandler } from "./types";

export const completeWithOpenAI: ProviderHandler = async ({
  rawModelId,
  messages,
  maxTokens,
  temperature,
}: ProviderCompleteArgs): Promise<ProviderCompleteResult> => {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const params: any = { model: rawModelId, messages };
  if (maxTokens) params.max_completion_tokens = maxTokens;
  if (temperature !== undefined) params.temperature = temperature;

  const response = await client.chat.completions.create(params);

  return {
    content: response.choices[0]?.message?.content || "",
    promptTokens: response.usage?.prompt_tokens || 0,
    completionTokens: response.usage?.completion_tokens || 0,
  };
};
