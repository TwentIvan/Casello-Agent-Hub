// Modelli dell'account di sistema "Gateway Casello": all'avvio `ensureSystemAccount`
// (lib/ai/system-account.ts) li usa solo per popolare `ai_models`. Devono coincidere con i
// model_name configurati in LiteLLM (repo TwentIvan/AIGateway). Le route /api/models e
// /api/analyses li leggono ancora finché non passano agli Account AI.

export const DEFAULT_MODEL = "openrouter/auto";

export const AVAILABLE_MODELS: Array<{ id: string; label: string }> = [
  { id: "openrouter/auto", label: "OpenRouter Auto" },
  { id: "openrouter/deepseek-chat", label: "DeepSeek Chat" },
  { id: "openrouter/qwen3-235b", label: "Qwen3 235B" },
  { id: "openrouter/mistral-small", label: "Mistral Small" },
];
