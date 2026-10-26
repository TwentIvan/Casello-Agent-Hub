import { LITELLM_PRICES_URL, OPENROUTER_MODELS_URL } from "../src/lib/catalog/sources";

/**
 * Fonti pubbliche finte per i test del catalogo: risposte di OpenRouter (`/api/v1/models`) e del
 * listino LiteLLM nelle forme reali. I prezzi di `deepseek-v4-pro` differiscono tra le due fonti, per
 * provare la precedenza.
 */

export const OPENROUTER_FIXTURE = {
  data: [
    {
      id: "deepseek/deepseek-chat",
      name: "DeepSeek: DeepSeek V3",
      created: 1735084800,
      context_length: 131072,
      pricing: { prompt: "0.00000027", completion: "0.0000011" },
      supported_parameters: ["tools", "temperature", "max_tokens"],
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek: DeepSeek V4 Pro",
      created: 1767225600,
      context_length: 1048576,
      pricing: { prompt: "0.00000174", completion: "0.00000348" },
      supported_parameters: ["tools", "tool_choice", "temperature"],
    },
    {
      id: "google/gemini-3.5-flash",
      name: "Google: Gemini 3.5 Flash",
      created: 1780000000,
      context_length: 1048576,
      pricing: { prompt: "0.0000003", completion: "0.0000025" },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "google/gemini-2.5-flash",
      name: "Google: Gemini 2.5 Flash",
      created: 1750000000,
      context_length: 1048576,
      pricing: { prompt: "0.0000003", completion: "0.0000025" },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "google/gemini-2.0-flash-exp:free",
      name: "Google: Gemini 2.0 Flash Experimental (free)",
      created: 1733900000,
      context_length: 1048576,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["temperature"],
    },
    {
      id: "mistralai/mistral-small",
      name: "Mistral: Mistral Small",
      created: 1706745600,
      context_length: 32768,
      pricing: { prompt: "0.0000002", completion: "0.0000006" },
      supported_parameters: ["tools", "temperature"],
    },
  ],
};

export const LITELLM_FIXTURE: Record<string, unknown> = {
  sample_spec: {
    max_tokens: "LEGACY parameter. set to max_output_tokens if provider specifies it.",
    max_input_tokens: "max input tokens, if the provider specifies it.",
    input_cost_per_token: 0.0,
    output_cost_per_token: 0.0,
    litellm_provider: "one of https://docs.litellm.ai/docs/providers",
    mode: "one of: chat, embedding, completion, image_generation, audio_transcription, audio_speech",
    supports_function_calling: true,
  },
  "deepseek/deepseek-v4-pro": {
    litellm_provider: "deepseek",
    mode: "chat",
    input_cost_per_token: 0.00000145,
    output_cost_per_token: 0.00000290,
    max_input_tokens: 1000000,
    max_output_tokens: 384000,
    supports_function_calling: true,
  },
  "gemini/gemini-2.5-flash": {
    litellm_provider: "gemini",
    mode: "chat",
    input_cost_per_token: 0.0000003,
    output_cost_per_token: 0.0000025,
    max_input_tokens: 1048576,
    supports_function_calling: true,
    deprecation_date: "2026-06-17",
  },
  "gemini/gemini-3.5-flash": {
    litellm_provider: "gemini",
    mode: "chat",
    input_cost_per_token: 0.0000003,
    output_cost_per_token: 0.0000025,
    max_input_tokens: 1048576,
    supports_function_calling: true,
  },
  "groq/llama-3.3-70b": {
    litellm_provider: "groq",
    mode: "chat",
    input_cost_per_token: 0.00000059,
    output_cost_per_token: 0.00000079,
    max_input_tokens: 131072,
    supports_function_calling: true,
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * `fetch` finto per le due fonti: un oggetto è il corpo JSON di una risposta 200, un numero lo stato
 * d'errore; senza opzioni servono le fixture. Gli altri URL vanno al `fetch` vero.
 */
export function fakeSourcesFetch(opts: { openrouter?: unknown | number; litellm?: unknown | number } = {}): typeof fetch {
  const realFetch = fetch;
  const reply = (v: unknown): Response => (typeof v === "number" ? new Response(null, { status: v }) : jsonResponse(v));
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === OPENROUTER_MODELS_URL) return reply(opts.openrouter ?? OPENROUTER_FIXTURE);
    if (url === LITELLM_PRICES_URL) return reply(opts.litellm ?? LITELLM_FIXTURE);
    return realFetch(input, init);
  }) as typeof fetch;
}
