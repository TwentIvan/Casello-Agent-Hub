import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { db, aiAccountsTable, aiModelsTable, providersTable } from "@workspace/db";
import {
  CHAT_MAX_RETRIES,
  CHAT_REQUEST_TIMEOUT_MS,
  applyTools,
  buildProxyParams,
  extractToolCalls,
  readUsage,
  type ChatResult,
} from "../ai-gateway";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { ProviderError, providerErrorKindForStatus } from "./discovery";
import { markModelUnavailable } from "./model-status";
import type { ProviderProtocol } from "../catalog/provider-registry-data";
import { normalizeBaseUrl, validateBaseUrl, type AiProvider } from "./providers";

/**
 * Esecutore unico dei modelli: risolve un modello (`ai_models.id`) nel suo account, con base URL,
 * chiave in chiaro (solo in memoria) e prezzi, poi chiama il provider con l'API compatibile OpenAI
 * e calcola il costo di ogni chiamata. Chiave, base URL e risposta grezza del provider non finiscono
 * mai in log né nei messaggi d'errore.
 */

/**
 * Tipo di esecutore, dal protocollo del provider: oggi solo `openai_compatible`; `local_agent` è il
 * prossimo sottoprogetto (agente locale via MCP) ed è solo dichiarato.
 */
export type ExecutorKind = "openai_compatible" | "local_agent";

export interface ResolvedModel {
  aiModelId: number;
  accountId: number;
  provider: AiProvider;
  kind: ExecutorKind;
  baseUrl: string;
  /**
   * Chiave in chiaro: solo in memoria, mai in log, risposte o errori. Proprietà non enumerabile:
   * `JSON.stringify`, `util.inspect` e lo spread (`{ ...resolved }`) non la copiano.
   */
  readonly apiKey: string | null;
  modelId: string;
  /** USD per milione di token; null se non noto. */
  priceInput: number | null;
  priceOutput: number | null;
  /** Proprietario dell'account; null per l'account di sistema. */
  ownerUserId: number | null;
}

export interface ChatOptions {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Tetto di tempo della singola richiesta HTTP (default CHAT_REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Nuovi tentativi dell'SDK (default CHAT_MAX_RETRIES). */
  maxRetries?: number;
  /** Servizio chiamante, per i log (es. "run-executor"). */
  caller: string;
  /** Solo per l'account di sistema: tag di telemetria verso LiteLLM. */
  agentId?: number;
}

export type ModelChatResult = ChatResult & { costUsd: number | null };

/** Modello inesistente, non accessibile all'utente o account di sistema non configurato. */
export class ModelAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelAccessError";
  }
}

const MODEL_UNAVAILABLE = "modello non disponibile";
const SYSTEM_UNAVAILABLE = "account di sistema non più disponibile";
const EXECUTOR_UNAVAILABLE = "esecutore non ancora disponibile";

const PROTOCOL_UNSUPPORTED = "esecutore non ancora disponibile per questo provider";

/**
 * Esecutore dal protocollo del provider: i compatibili OpenAI e i provider non gestiti (`unknown`, configurati
 * come compatibili OpenAI) usano l'esecutore esistente; gli altri protocolli non hanno ancora un esecutore.
 */
export function executorKindFor(protocol: ProviderProtocol): ExecutorKind {
  if (protocol === "openai_compatible" || protocol === "unknown") return "openai_compatible";
  throw new ModelAccessError(PROTOCOL_UNSUPPORTED);
}

/** Costo in USD: null se manca un prezzo; arrotondato a 8 decimali. */
export function computeCost(
  promptTokens: number,
  completionTokens: number,
  priceIn: number | null,
  priceOut: number | null,
): number | null {
  if (priceIn === null || priceOut === null) return null;
  const cost = (promptTokens * priceIn) / 1e6 + (completionTokens * priceOut) / 1e6;
  return Math.round(cost * 1e8) / 1e8;
}

function toPrice(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Carica modello e account. Con `mustOwn` l'account deve essere dell'utente o di sistema; senza
 * (run di un agente: chi configura paga) basta che il modello esista.
 */
export async function resolveModel(aiModelId: number, opts: { userId: number | null; mustOwn: boolean }): Promise<ResolvedModel> {
  const [row] = await db
    .select({ model: aiModelsTable, account: aiAccountsTable, protocol: providersTable.protocol })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .innerJoin(providersTable, eq(aiAccountsTable.provider, providersTable.slug))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  if (!row) throw new ModelAccessError(MODEL_UNAVAILABLE);
  const { model, account, protocol } = row;
  // Difesa in profondità: l'account di sistema non ha proprietario, tutti gli altri sì
  if ((account.provider === "system_gateway") !== (account.userId === null)) {
    throw new ModelAccessError(MODEL_UNAVAILABLE);
  }
  if (opts.mustOwn && account.userId !== null && account.userId !== opts.userId) {
    throw new ModelAccessError(MODEL_UNAVAILABLE);
  }
  const kind = executorKindFor(protocol);

  let baseUrl: string;
  let apiKey: string | null;
  if (account.provider === "system_gateway") {
    // Configurato dall'operatore (può essere un indirizzo interno): niente validateBaseUrl
    const envUrl = process.env["AI_GATEWAY_BASE_URL"];
    const envKey = process.env["AI_GATEWAY_API_KEY"];
    if (!envUrl || !envKey) throw new ModelAccessError(SYSTEM_UNAVAILABLE);
    baseUrl = normalizeBaseUrl(envUrl);
    apiKey = envKey;
  } else {
    // Rivalidato a ogni chiamata: le regole possono essere cambiate dopo il salvataggio
    if (validateBaseUrl(account.baseUrl, account.allowPrivateNetwork) !== null) throw new ProviderError("bad_url");
    baseUrl = normalizeBaseUrl(account.baseUrl);
    if (account.apiKeyEnc === null) {
      apiKey = null;
    } else {
      try {
        apiKey = decryptSecret(account.apiKeyEnc);
      } catch {
        throw new ProviderError("auth");
      }
    }
  }

  const resolved = {
    aiModelId: model.id,
    accountId: account.id,
    provider: account.provider,
    kind,
    baseUrl,
    modelId: model.modelId,
    priceInput: toPrice(model.priceInputPerMtok),
    priceOutput: toPrice(model.priceOutputPerMtok),
    ownerUserId: account.userId,
  } as ResolvedModel;
  Object.defineProperty(resolved, "apiKey", { value: apiKey, enumerable: false, writable: false, configurable: false });
  return resolved;
}

// Un client per account, ricreato quando cambiano chiave o base URL. La chiave non è mai una
// chiave della mappa: si confronta solo il suo hash.
const clients = new Map<number, { fingerprint: string; client: OpenAI }>();

function clientFor(resolved: ResolvedModel): OpenAI {
  const fingerprint = createHash("sha256").update(`${resolved.baseUrl}\n${resolved.apiKey ?? ""}`).digest("hex");
  const cached = clients.get(resolved.accountId);
  if (cached && cached.fingerprint === fingerprint) return cached.client;
  const client = new OpenAI({
    baseURL: resolved.baseUrl,
    apiKey: resolved.apiKey ?? "",
    // Niente variabili OPENAI_* dell'ambiente: solo i dati dell'account
    organization: null,
    project: null,
    // Senza chiave nessun header Authorization
    ...(resolved.apiKey === null ? { defaultHeaders: { Authorization: null } } : {}),
    // Nessun redirect seguito: un 3xx diventa un errore del provider
    fetchOptions: { redirect: "manual" },
    // L'SDK non scrive mai in console (i suoi log includono il base URL)
    logLevel: "off",
  });
  clients.set(resolved.accountId, { fingerprint, client });
  return client;
}

function buildParams(resolved: ResolvedModel, opts: ChatOptions): ChatCompletionCreateParamsNonStreaming {
  const base = { model: resolved.modelId, messages: opts.messages };
  let params: ChatCompletionCreateParamsNonStreaming;
  if (resolved.provider === "system_gateway") {
    // LiteLLM: stessi parametri di aiGateway.chat (metadati di telemetria inclusi)
    params = buildProxyParams(base, opts, opts.caller);
  } else {
    // Provider diretto: soli parametri OpenAI standard (max_tokens è il più supportato)
    params = { ...base };
    if (opts.maxTokens) params.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
  }
  applyTools(params, opts.tools ?? []);
  return params;
}

/** Il provider dice che il modello non esiste (più): 404 o codice `model_not_found`. */
function isModelNotFound(err: unknown): boolean {
  return err instanceof APIError && !(err instanceof APIConnectionError) && (err.status === 404 || err.code === "model_not_found");
}

function isTimeoutOrAbort(err: unknown): boolean {
  return err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError;
}

/**
 * Errori della chiamata → ProviderError con testo fisso; timeout e abort dell'SDK restano invariati.
 * Ogni altro errore (rete, risposta non JSON o troncata, errori interni dell'SDK) diventa
 * "unreachable": il suo messaggio potrebbe contenere URL o il corpo della risposta.
 */
function mapError(err: unknown): unknown {
  if (isTimeoutOrAbort(err)) return err;
  if (err instanceof ProviderError) return err;
  if (err instanceof APIError && !(err instanceof APIConnectionError) && typeof err.status === "number") {
    return new ProviderError(providerErrorKindForStatus(err.status), err.status);
  }
  return new ProviderError("unreachable");
}

/**
 * Chiamata al modello risolto. Errori: `ProviderError` (kind e status HTTP) per le risposte
 * d'errore e i problemi di rete (con 404 o `model_not_found` il modello diventa `unavailable`);
 * `APIConnectionTimeoutError` e `APIUserAbortError` dell'SDK invariati, così chi distingue il
 * timeout (l'architetto) continua a farlo.
 */
export async function modelChat(resolved: ResolvedModel, opts: ChatOptions): Promise<ModelChatResult> {
  if (resolved.kind !== "openai_compatible") throw new Error(EXECUTOR_UNAVAILABLE);
  const client = clientFor(resolved);
  const params = buildParams(resolved, opts);
  const startMs = Date.now();
  let result: ModelChatResult;
  let cachedTokens: number;
  try {
    const response = await client.chat.completions.create(params, {
      signal: opts.signal,
      maxRetries: opts.maxRetries ?? CHAT_MAX_RETRIES,
      timeout: opts.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS,
    });
    // Risposta 2xx malformata (senza `choices`): errore del provider, mai un TypeError grezzo
    if (!Array.isArray(response?.choices) || response.choices.length === 0) throw new ProviderError("unreachable");
    const usage = readUsage(response);
    cachedTokens = usage.cachedTokens;
    const content = response.choices[0]?.message?.content;
    result = {
      content: typeof content === "string" ? content : null,
      toolCalls: extractToolCalls(response),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: response.usage
        ? computeCost(usage.promptTokens, usage.completionTokens, resolved.priceInput, resolved.priceOutput)
        : null,
    };
  } catch (err) {
    // Con il signal scaduto solo abort e timeout dell'SDK passano invariati
    const mapped = mapError(err);
    if (mapped !== err) {
      logger.warn(
        { caller: opts.caller, accountId: resolved.accountId, modelId: resolved.modelId, errName: err instanceof Error ? err.name : "unknown" },
        "Chiamata al modello non riuscita",
      );
    }
    // Ritiro senza costi: la chiamata reale che trova il modello sparito lo segna non disponibile
    if (isModelNotFound(err)) await markModelUnavailable(resolved.aiModelId);
    throw mapped;
  }
  const durationMs = Date.now() - startMs;
  // Mai chiave, base URL o contenuti dei messaggi nei log
  logger.info(
    {
      caller: opts.caller,
      accountId: resolved.accountId,
      modelId: resolved.modelId,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens,
      durationMs,
    },
    "Chiamata al modello",
  );
  return result;
}
