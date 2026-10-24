// Modelli selezionabili per gli agenti: devono coincidere con i model_name
// configurati in LiteLLM (repo TwentIvan/AIGateway). Per ora costanti; in
// futuro da GET /v1/models del gateway.

export const DEFAULT_MODEL = "openrouter/auto";

export const AVAILABLE_MODELS: Array<{ id: string; label: string }> = [
  { id: "openrouter/auto", label: "OpenRouter Auto" },
  { id: "openrouter/deepseek-chat", label: "DeepSeek Chat" },
  { id: "openrouter/qwen3-235b", label: "Qwen3 235B" },
  { id: "openrouter/mistral-small", label: "Mistral Small" },
];
