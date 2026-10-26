import { readBytesLimited } from "../http-read";
import { findSeedPrice } from "./price-seed";
import { normalizeBaseUrl, validateBaseUrl, type AiProvider } from "./providers";

/**
 * Scoperta dei modelli di un account: `GET {baseUrl}/models` compatibile OpenAI, con timeout,
 * senza redirect e con risposta limitata in dimensione e numero di voci. Gli errori hanno testi
 * fissi (spec §7): mai la chiave, l'URL o il corpo della risposta del provider nei messaggi.
 */

export type ProviderErrorKind = "auth" | "credit" | "rate" | "rejected" | "unreachable" | "no_models" | "bad_url";

export const PROVIDER_MESSAGES: Record<ProviderErrorKind, string> = {
  auth: "chiave non valida o senza permessi",
  credit: "credito del provider esaurito: ricarica il conto o scegli un altro modello",
  rate: "limite di richieste del provider: riprova più tardi",
  // Con lo stato HTTP: "richiesta rifiutata dal provider (HTTP 400)" (vedi providerErrorMessage)
  rejected: "richiesta rifiutata dal provider",
  unreachable: "provider non raggiungibile",
  no_models: "il provider non fornisce l'elenco dei modelli: aggiungili a mano",
  bad_url: "indirizzo non consentito",
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** Stato HTTP della risposta del provider; null per errori di rete, timeout o indirizzo. */
  readonly status: number | null;
  constructor(kind: ProviderErrorKind, status: number | null = null) {
    super(providerErrorMessage(kind, status));
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

/** Messaggio fisso di un errore; per "rejected" include solo il numero dello stato HTTP. */
export function providerErrorMessage(kind: ProviderErrorKind, status: number | null): string {
  if (kind === "rejected" && status !== null) return `${PROVIDER_MESSAGES.rejected} (HTTP ${status})`;
  return PROVIDER_MESSAGES[kind];
}

/**
 * Tipo d'errore per uno stato HTTP non riuscito del provider: 401/403 auth, 402 credit, 429 rate,
 * altri 4xx rejected; 3xx (redirect non seguiti) e 5xx unreachable.
 */
export function providerErrorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credit";
  if (status === 429) return "rate";
  if (status >= 400 && status < 500) return "rejected";
  return "unreachable";
}

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  contextTokens: number | null;
  /** USD per milione di token. */
  priceInput: number | null;
  priceOutput: number | null;
  priceSource: "provider" | "seed" | null;
}

export interface DiscoveryAccount {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string | null;
  /** Consente `http` e indirizzi privati: la route lo ammette solo per il provider custom. */
  allowPrivateNetwork?: boolean;
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_097_152;
const MAX_MODELS = 2_000;
const MAX_ID_LENGTH = 256;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Prezzi oltre questa soglia (USD per milione di token) sono considerati dati sbagliati. */
const MAX_PRICE_PER_MTOK = 1e6;
const MAX_DISPLAY_NAME_LENGTH = 256;
// Solo numeri decimali (con esponente opzionale): niente esadecimali, Infinity, segni
const DECIMAL_RE = /^\d+(\.\d+)?([eE][-+]?\d+)?$/;
// Caratteri di controllo C0, DEL e C1
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** Prezzo per token (numero o stringa decimale, come OpenRouter) → USD per milione, arrotondato a 6 decimali. */
function perMillion(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && DECIMAL_RE.test(v.trim())) n = Number(v.trim());
  else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  const perMtok = Math.round(n * 1e12) / 1e6;
  return Number.isFinite(perMtok) && perMtok < MAX_PRICE_PER_MTOK ? perMtok : null;
}

/** Contesto in token: intero positivo, anche come stringa decimale intera. */
function contextTokens(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function toModel(provider: AiProvider, entry: Record<string, unknown>, id: string): DiscoveredModel {
  const nameRaw = typeof entry["name"] === "string" ? entry["name"] : entry["display_name"];
  const nameTrim = typeof nameRaw === "string" ? nameRaw.trim() : "";
  const displayName = (nameTrim !== "" && !CONTROL_RE.test(nameTrim) ? nameTrim : id).slice(0, MAX_DISPLAY_NAME_LENGTH);
  const pricing = isObj(entry["pricing"]) ? entry["pricing"] : {};
  let priceInput = perMillion(pricing["prompt"]);
  let priceOutput = perMillion(pricing["completion"]);
  let priceSource: DiscoveredModel["priceSource"] = priceInput !== null || priceOutput !== null ? "provider" : null;
  if (priceSource === null) {
    const seed = findSeedPrice(provider, id);
    if (seed) {
      priceInput = seed.input;
      priceOutput = seed.output;
      priceSource = "seed";
    }
  }
  return { modelId: id, displayName, contextTokens: contextTokens(entry["context_length"]), priceInput, priceOutput, priceSource };
}

export async function discoverModels(account: DiscoveryAccount, fetchImpl: typeof fetch = fetch): Promise<DiscoveredModel[]> {
  if (validateBaseUrl(account.baseUrl, account.allowPrivateNetwork === true) !== null) {
    throw new ProviderError("bad_url");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (account.apiKey !== null) headers["authorization"] = `Bearer ${account.apiKey}`;

  let res: Response;
  try {
    res = await fetchImpl(`${normalizeBaseUrl(account.baseUrl)}/models`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Rete o timeout: l'errore originale può contenere l'URL, non va propagato
    throw new ProviderError("unreachable");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    // I redirect (3xx) non si seguono: provider non raggiungibile
    throw new ProviderError(res.status === 404 ? "no_models" : providerErrorKindForStatus(res.status), res.status);
  }

  let json: unknown;
  try {
    const bytes = await readBytesLimited(res, MAX_BYTES);
    json = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown;
  } catch {
    throw new ProviderError("unreachable", res.status);
  }

  // Forma OpenAI `{ data: [...] }`; alcuni provider (es. Together) restituiscono l'array nudo
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json["data"]) ? json["data"] : null;
  if (list === null) throw new ProviderError("no_models", res.status);

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of list) {
    if (models.length >= MAX_MODELS) break;
    if (!isObj(entry)) continue;
    const rawId = entry["id"];
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (id === "" || id.length > MAX_ID_LENGTH || CONTROL_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push(toModel(account.provider, entry, id));
  }
  return models;
}
