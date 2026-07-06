import type { GatewayMessage } from "../ai-gateway";

export interface ProviderCompleteArgs {
  rawModelId: string;
  messages: GatewayMessage[];
  maxTokens?: number;
  temperature?: number;
  caller: string;
}

export interface ProviderCompleteResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * One module per provider callable without the LiteLLM proxy. To add support
 * for a new provider when it becomes available: write a new module
 * implementing this signature, then register it in `./index.ts`. Nothing
 * else in the gateway needs to change.
 */
export type ProviderHandler = (args: ProviderCompleteArgs) => Promise<ProviderCompleteResult>;
