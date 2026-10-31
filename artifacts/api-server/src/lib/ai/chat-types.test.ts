import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { readUsage } from "./chat-types";

describe("readUsage", () => {
  const response = (usage: Record<string, unknown> | undefined) => ({ choices: [], usage }) as unknown as ChatCompletion;

  it("token in cache da prompt_tokens_details (OpenAI, OpenRouter, Gemini)", () => {
    const u = readUsage(response({ prompt_tokens: 1_000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } }));
    expect(u).toEqual({ promptTokens: 1_000, completionTokens: 10, cachedTokens: 800 });
  });

  it("token in cache nella forma DeepSeek (prompt_cache_hit_tokens)", () => {
    const u = readUsage(response({ prompt_tokens: 1_000, completion_tokens: 10, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 }));
    expect(u.cachedTokens).toBe(700);
  });

  it("senza nessuna delle due forme → 0", () => {
    expect(readUsage(response({ prompt_tokens: 1_000, completion_tokens: 10 })).cachedTokens).toBe(0);
    expect(readUsage(response(undefined)).cachedTokens).toBe(0);
  });

  it("con entrambe prevale prompt_tokens_details; mai oltre i token di prompt", () => {
    const both = readUsage(response({ prompt_tokens: 1_000, prompt_tokens_details: { cached_tokens: 600 }, prompt_cache_hit_tokens: 700 }));
    expect(both.cachedTokens).toBe(600);
    expect(readUsage(response({ prompt_tokens: 100, prompt_cache_hit_tokens: 700 })).cachedTokens).toBe(100);
    expect(readUsage(response({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -5 } })).cachedTokens).toBe(0);
  });
});
