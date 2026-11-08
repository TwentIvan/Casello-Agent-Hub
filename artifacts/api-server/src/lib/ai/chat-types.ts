// Tipi e funzioni condivise delle chiamate ai modelli (formato compatibile OpenAI): messaggi, tool call,
// esito di una chiamata e lettura della risposta. Li usano l'esecutore unico (`executor.ts`), il ciclo
// dell'agente, l'architetto e la chat del piano.

import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export type ChatMessageContent =
  | string
  | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;

export type ChatMessage =
  | { role: "system" | "user"; content: ChatMessageContent }
  | { role: "assistant"; content?: string | null };

export interface ChatToolCall {
  id: string;
  name: string;
  /** Argomenti come stringa JSON, così come li ha prodotti il modello (non validata) */
  arguments: string;
  /**
   * Campi in più della tool call oltre a quelli OpenAI, da rimandare invariati al turno successivo: per
   * esempio la firma del ragionamento di Gemini 3 (`extra_content.google.thought_signature`), senza la
   * quale il provider rifiuta la richiesta con un 400.
   */
  extra?: Record<string, unknown>;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ChatToolCall[];
  /** Token di prompt in totale, compresi quelli letti dalla cache */
  promptTokens: number;
  completionTokens: number;
  /** Quanti dei token di prompt il provider ha letto dalla cache (0 se non lo riporta) */
  cachedPromptTokens: number;
  /**
   * Il provider ha interrotto la risposta per il limite di token di uscita (`finish_reason: "length"`): il testo
   * è un frammento e le tool call possono mancare. Assente = risposta completa.
   */
  truncated?: boolean;
}

// Chiamate con function calling (run degli agenti): un nuovo tentativo al massimo e un tetto di
// tempo per singola richiesta. Il tempo del turno lo limita il signal passato da run-executor.
// Chi ha esigenze diverse (l'architetto) li sovrascrive con `timeoutMs` e `maxRetries`.
export const CHAT_MAX_RETRIES = 1;
export const CHAT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Uso della risposta. I token in cache arrivano in `prompt_tokens_details.cached_tokens` (OpenAI, OpenRouter,
 * Gemini) o, da DeepSeek, in `prompt_cache_hit_tokens` (non nei tipi dell'SDK); con entrambi prevale il primo.
 * Sono sempre tra 0 e i token di prompt, anche se il provider riporta altro.
 */
export function readUsage(response: ChatCompletion): { promptTokens: number; completionTokens: number; cachedTokens: number } {
  const usage = response.usage as (ChatCompletion["usage"] & { prompt_cache_hit_tokens?: number }) | undefined;
  const promptTokens = usage?.prompt_tokens || 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
  return {
    promptTokens,
    completionTokens: usage?.completion_tokens || 0,
    cachedTokens: Number.isFinite(cached) ? Math.min(Math.max(0, cached), promptTokens) : 0,
  };
}

/** Aggiunge i tool alla richiesta, con scelta automatica del modello. */
export function applyTools(params: ChatCompletionCreateParamsNonStreaming, tools: ChatCompletionTool[]): void {
  if (tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
  }
}

/**
 * Tool calls di tipo funzione di tutte le scelte della risposta, nell'ordine. Si chiede sempre una sola
 * risposta (`n` non si manda), ma l'endpoint compatibile OpenAI di Gemini può dividere le parti di un'unica
 * risposta (testo, chiamate) su più `choices`: leggere solo la prima perderebbe le chiamate. Una tool call
 * con lo stesso id ripetuta in più scelte si tiene una volta sola.
 */
export function extractToolCalls(response: ChatCompletion): ChatToolCall[] {
  const toolCalls: ChatToolCall[] = [];
  const seen = new Set<string>();
  for (const choice of response.choices ?? []) {
    for (const call of choice?.message?.tool_calls ?? []) {
      if (call.type !== "function") continue;
      const { id, type: _type, function: fn, ...rest } = call as ChatCompletionMessageFunctionToolCall & Record<string, unknown>;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const toolCall: ChatToolCall = { id, name: fn.name, arguments: fn.arguments };
      if (Object.keys(rest).length) toolCall.extra = rest;
      toolCalls.push(toolCall);
    }
  }
  return toolCalls;
}

/**
 * Testo di tutte le scelte della risposta, unito nell'ordine (vedi `extractToolCalls`); null se nessuna scelta
 * ha testo.
 */
export function extractContent(response: ChatCompletion): string | null {
  const parts: string[] = [];
  for (const choice of response.choices ?? []) {
    const content = choice?.message?.content;
    if (typeof content === "string" && content !== "") parts.push(content);
  }
  return parts.length ? parts.join("") : null;
}

/** Vero se una scelta della risposta si è fermata per il limite di token di uscita. */
export function isTruncated(response: ChatCompletion): boolean {
  return (response.choices ?? []).some((c) => c?.finish_reason === "length");
}

/** Tool calls da rimettere nella cronologia come messaggio dell'assistente, con i campi in più del provider. */
export function assistantToolCalls(calls: ChatToolCall[]): ChatCompletionMessageFunctionToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: c.arguments },
    ...c.extra,
  }));
}

