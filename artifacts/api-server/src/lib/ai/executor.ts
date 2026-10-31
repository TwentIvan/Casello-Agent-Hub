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
  extractToolCalls,
  readUsage,
  type ChatResult,
} from "./chat-types";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { ProviderError, providerErrorKindForStatus } from "./discovery";
import { markModelUnavailable } from "./model-status";
import type { ProviderProtocol } from "../catalog/provider-registry-data";
import { normalizeBaseUrl, privateNetworkAllowed, validateBaseUrl, type AiProvider } from "./providers";

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
  /** Prezzo dei token di prompt letti dalla cache; null se non noto (si paga il prezzo pieno). */
  priceCachedInput: number | null;
  /** Finestra di contesto in token (da `ai_models.context_tokens`); null se non nota. */
  contextTokens: number | null;
  /** Proprietario dell'account. */
  ownerUserId: number;
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
}

export type ModelChatResult = ChatResult & { costUsd: number | null };

/** Modello inesistente o non accessibile all'utente. */
export class ModelAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelAccessError";
  }
}

const MODEL_UNAVAILABLE = "modello non disponibile";
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

/**
 * Costo in USD: null se manca il prezzo di input o di output; arrotondato a 8 decimali. I token di prompt
 * letti dalla cache (compresi in `promptTokens`) costano `priceCachedIn`, o il prezzo pieno se non è noto.
 */
export function computeCost(
  promptTokens: number,
  completionTokens: number,
  priceIn: number | null,
  priceOut: number | null,
  cachedTokens = 0,
  priceCachedIn: number | null = null,
): number | null {
  if (priceIn === null || priceOut === null) return null;
  const cost =
    (cachedTokens * (priceCachedIn ?? priceIn)) / 1e6 +
    ((promptTokens - cachedTokens) * priceIn) / 1e6 +
    (completionTokens * priceOut) / 1e6;
  return Math.round(cost * 1e8) / 1e8;
}

function toPrice(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Carica modello e account. Con `mustOwn` l'account deve essere dell'utente; senza (run di un agente:
 * chi configura paga) basta che il modello esista.
 */
export async function resolveModel(aiModelId: number, opts: { userId: number | null; mustOwn: boolean }): Promise<ResolvedModel> {
  const [row] = await db
    .select({ model: aiModelsTable, account: aiAccountsTable, protocol: providersTable.protocol, providerStatus: providersTable.status })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .innerJoin(providersTable, eq(aiAccountsTable.provider, providersTable.slug))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  if (!row) throw new ModelAccessError(MODEL_UNAVAILABLE);
  const { model, account, protocol, providerStatus } = row;
  // Ogni account ha un proprietario: quelli senza (il vecchio account di sistema del gateway, finché la
  // migrazione `-post` non lo elimina) non sono più utilizzabili
  if (account.userId === null) throw new ModelAccessError(MODEL_UNAVAILABLE);
  if (opts.mustOwn && account.userId !== opts.userId) {
    throw new ModelAccessError(MODEL_UNAVAILABLE);
  }
  const kind = executorKindFor(protocol);

  // Rivalidato a ogni chiamata: le regole (e lo stato del provider) possono essere cambiate dopo il salvataggio
  const allowPrivate = account.allowPrivateNetwork && privateNetworkAllowed({ slug: account.provider, status: providerStatus });
  if (validateBaseUrl(account.baseUrl, allowPrivate) !== null) throw new ProviderError("bad_url");
  const baseUrl = normalizeBaseUrl(account.baseUrl);
  let apiKey: string | null = null;
  if (account.apiKeyEnc !== null) {
    try {
      apiKey = decryptSecret(account.apiKeyEnc);
    } catch {
      throw new ProviderError("auth");
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
    priceCachedInput: toPrice(model.priceCachedInputPerMtok),
    contextTokens: model.contextTokens,
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

/**
 * Id del modello come lo vuole il provider nella chiamata. Gemini elenca i modelli come `models/<id>` ma
 * l'endpoint compatibile OpenAI risponde 404 con il prefisso: si manda l'id senza. Gli altri così com'è.
 */
export function providerModelName(provider: string, modelId: string): string {
  return provider === "gemini" ? modelId.replace(/^models\//i, "") : modelId;
}

function buildParams(resolved: ResolvedModel, opts: ChatOptions): ChatCompletionCreateParamsNonStreaming {
  const base = { model: providerModelName(resolved.provider, resolved.modelId), messages: opts.messages };
  // Soli parametri OpenAI standard (max_tokens è il più supportato)
  const params: ChatCompletionCreateParamsNonStreaming = { ...base };
  if (opts.maxTokens) params.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) params.temperature = opts.temperature;
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
    const kind = providerErrorKindForStatus(err.status);
    return new ProviderError(kind, err.status, kind === "rate" ? retryAfterMs(err) : null);
  }
  return new ProviderError("unreachable");
}

/** Stato HTTP di un errore del provider o dell'SDK; null per gli errori di rete e gli altri errori. */
export function errorStatus(err: unknown): number | null {
  if (err instanceof ProviderError) return err.status;
  if (err instanceof APIError && typeof err.status === "number") return err.status;
  return null;
}

/**
 * Campi per i log del server: classe vera dell'errore (le classi dell'SDK `openai` non impostano
 * `name`, che resterebbe "Error") e stato HTTP. Mai il messaggio: può contenere URL o la risposta.
 */
export function errorLogFields(err: unknown): { errName: string; status: number | null } {
  const errName = err instanceof Error ? (err.name !== "Error" ? err.name : err.constructor.name) : "unknown";
  return { errName, status: errorStatus(err) };
}

/** Attesa massima suggerita da un provider che si accetta (oltre si usa questa). */
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Attesa suggerita da un 429: intestazioni `retry-after-ms` / `retry-after` (secondi o data) o, come fa
 * Gemini, `retryDelay` ("30s") nei dettagli dell'errore. Null se il provider non la indica.
 */
export function retryAfterMs(err: APIError): number | null {
  const header = (name: string) => err.headers?.get?.(name) ?? null;
  let ms: number | null = null;
  const msHeader = Number(header("retry-after-ms"));
  const after = header("retry-after");
  if (header("retry-after-ms") !== null && Number.isFinite(msHeader)) ms = msHeader;
  else if (after !== null && after.trim() !== "" && Number.isFinite(Number(after))) ms = Number(after) * 1000;
  else if (after !== null && !Number.isNaN(Date.parse(after))) ms = Date.parse(after) - Date.now();
  else {
    const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(JSON.stringify(err.error ?? null));
    if (delay) ms = Number(delay[1]) * 1000;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
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
  try {
    const response = await client.chat.completions.create(params, {
      signal: opts.signal,
      maxRetries: opts.maxRetries ?? CHAT_MAX_RETRIES,
      timeout: opts.timeoutMs ?? CHAT_REQUEST_TIMEOUT_MS,
    });
    // Risposta 2xx malformata (senza `choices`): errore del provider, mai un TypeError grezzo
    if (!Array.isArray(response?.choices) || response.choices.length === 0) throw new ProviderError("unreachable");
    const usage = readUsage(response);
    const content = response.choices[0]?.message?.content;
    result = {
      content: typeof content === "string" ? content : null,
      toolCalls: extractToolCalls(response),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedPromptTokens: usage.cachedTokens,
      costUsd: response.usage
        ? computeCost(
            usage.promptTokens,
            usage.completionTokens,
            resolved.priceInput,
            resolved.priceOutput,
            usage.cachedTokens,
            resolved.priceCachedInput,
          )
        : null,
    };
  } catch (err) {
    // Con il signal scaduto solo abort e timeout dell'SDK passano invariati
    const mapped = mapError(err);
    if (mapped !== err) {
      logger.warn(
        { caller: opts.caller, accountId: resolved.accountId, modelId: resolved.modelId, ...errorLogFields(err) },
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
      cachedTokens: result.cachedPromptTokens,
      durationMs,
    },
    "Chiamata al modello",
  );
  return result;
}
