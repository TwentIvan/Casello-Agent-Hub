import { completeWithOpenAI } from "./openai";
import { completeWithAnthropic } from "./anthropic";
import type { ProviderHandler } from "./types";

/**
 * Providers callable directly (no LiteLLM proxy), keyed by the prefix used
 * in modelKey (e.g. "openai/gpt-4o" -> "openai"). To support a new provider
 * in direct mode: add a module next to openai.ts/anthropic.ts, then add one
 * line here.
 */
export const directProviders: Record<string, ProviderHandler> = {
  openai: completeWithOpenAI,
  anthropic: completeWithAnthropic,
};

export type { ProviderCompleteArgs, ProviderCompleteResult, ProviderHandler } from "./types";
