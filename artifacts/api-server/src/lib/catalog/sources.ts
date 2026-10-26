import { readBytesLimited } from "../http-read";
import { cleanId, cleanName, contextTokens, perMillion } from "../ai/sanitize";

/**
 * Fonti pubbliche del catalogo dei modelli: l'elenco di OpenRouter e il listino di LiteLLM.
 * Gli indirizzi sono fissi nel codice (mai forniti dagli utenti); nessun redirect seguito, risposta
 * limitata a 20 MB. Gli errori hanno testi fissi: mai URL o corpo della risposta nei messaggi.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 20_971_520;

export type SourceName = "openrouter" | "litellm";

export interface SourceEntry {
  source: SourceName;
  /** Id OpenRouter o chiave LiteLLM così come arrivano, già ripuliti. */
  key: string;
  litellmProvider: string | null;
  name: string | null;
  releasedAt: Date | null;
  /** USD per milione di token. */
  priceInput: number | null;
  priceOutput: number | null;
  contextTokens: number | null;
  supportsTools: boolean | null;
  deprecationDate: Date | null;
}

const SOURCE_LABELS: Record<SourceName, string> = { openrouter: "OpenRouter", litellm: "LiteLLM" };

export class SourceError extends Error {
  readonly source: SourceName;
  constructor(source: SourceName) {
    super(`fonte ${SOURCE_LABELS[source]} non raggiungibile: dati non aggiornati`);
    this.name = "SourceError";
    this.source = source;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Scarica e decodifica il JSON di una fonte; ogni problema diventa un `SourceError` a testo fisso. */
async function fetchJson(source: SourceName, url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Rete o timeout: l'errore originale può contenere l'URL
    throw new SourceError(source);
  }
  if (!res.ok) {
    // Anche i redirect (3xx) non si seguono
    await res.body?.cancel().catch(() => {});
    throw new SourceError(source);
  }
  try {
    const bytes = await readBytesLimited(res, MAX_BYTES);
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown;
  } catch {
    // Corpo oltre il limite o JSON non valido
    throw new SourceError(source);
  }
}

export async function fetchOpenRouterSource(fetchImpl: typeof fetch = fetch): Promise<SourceEntry[]> {
  const json = await fetchJson("openrouter", OPENROUTER_MODELS_URL, fetchImpl);
  if (!isObj(json) || !Array.isArray(json["data"])) throw new SourceError("openrouter");
  const entries: SourceEntry[] = [];
  for (const item of json["data"]) {
    if (!isObj(item)) continue;
    const key = cleanId(item["id"]);
    if (key === null) continue;
    const created = item["created"];
    const pricing = isObj(item["pricing"]) ? item["pricing"] : {};
    const params = item["supported_parameters"];
    entries.push({
      source: "openrouter",
      key,
      litellmProvider: null,
      name: cleanName(item["name"]),
      releasedAt:
        typeof created === "number" && Number.isSafeInteger(created) && created > 0 ? dateFromSeconds(created) : null,
      priceInput: perMillion(pricing["prompt"]),
      priceOutput: perMillion(pricing["completion"]),
      contextTokens: contextTokens(item["context_length"]),
      supportsTools: Array.isArray(params) ? params.includes("tools") : null,
      deprecationDate: null,
    });
  }
  return entries;
}

function dateFromSeconds(seconds: number): Date | null {
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `YYYY-MM-DD` valida → mezzanotte UTC; qualsiasi altra forma → null. */
function parseIsoDay(v: unknown): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  // Scarta date impossibili (es. 2026-02-31, che Date sposterebbe al mese dopo)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? d : null;
}

export async function fetchLiteLlmSource(fetchImpl: typeof fetch = fetch): Promise<SourceEntry[]> {
  const json = await fetchJson("litellm", LITELLM_PRICES_URL, fetchImpl);
  if (!isObj(json)) throw new SourceError("litellm");
  const entries: SourceEntry[] = [];
  for (const [rawKey, item] of Object.entries(json)) {
    if (rawKey === "sample_spec" || !isObj(item)) continue;
    const key = cleanId(rawKey);
    if (key === null) continue;
    const supportsTools = item["supports_function_calling"];
    entries.push({
      source: "litellm",
      key,
      litellmProvider: cleanName(item["litellm_provider"]),
      name: null,
      releasedAt: null,
      priceInput: perMillion(item["input_cost_per_token"]),
      priceOutput: perMillion(item["output_cost_per_token"]),
      contextTokens: contextTokens(item["max_input_tokens"]),
      supportsTools: typeof supportsTools === "boolean" ? supportsTools : null,
      deprecationDate: parseIsoDay(item["deprecation_date"]),
    });
  }
  return entries;
}
