import { logger } from "../logger";
import type { ResolvedModel } from "../ai/executor";
import { ALFRED_MESSAGES, GEMINI_TIMEOUT_MS, bareModelName, geminiNativeBase } from "./config";

/** Errore di Alfred con stato HTTP; il messaggio è fisso, italiano e sicuro da restituire. */
export class AlfredError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AlfredError";
  }
}

/**
 * Verifica con la chiave dell'account che il modello supporti `bidiGenerateContent` (Gemini Live).
 * Nessun redirect, 15 s. Modello assente o senza il metodo → 400; chiave rifiutata (400 API_KEY_INVALID, 401, 403) → 502; rete o altro → 502.
 */
export async function checkLiveSupport(model: ResolvedModel): Promise<void> {
  const name = bareModelName(model.modelId);
  if (!model.apiKey) throw new AlfredError(ALFRED_MESSAGES.geminiKeyRejected, 502);
  let res: Response;
  try {
    res = await fetch(`${geminiNativeBase()}/models/${encodeURIComponent(name)}`, {
      headers: { "x-goog-api-key": model.apiKey },
      redirect: "manual",
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch {
    throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  }
  if (res.status === 404) throw new AlfredError(ALFRED_MESSAGES.modelUnsuitable, 400);
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    logger.warn({ operation: "models", status: res.status }, "Gemini ha rifiutato la richiesta");
    throw new AlfredError(ALFRED_MESSAGES.geminiKeyRejected, 502);
  }
  if (!res.ok) {
    logger.warn({ operation: "models", status: res.status }, "Gemini ha risposto con un errore");
    throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  }
  let methods: unknown;
  try {
    methods = ((await res.json()) as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
  } catch {
    throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  }
  if (!Array.isArray(methods) || !methods.includes("bidiGenerateContent")) {
    throw new AlfredError(ALFRED_MESSAGES.modelUnsuitable, 400);
  }
}

/** Durata del token (apertura di nuove sessioni entro 1 minuto, sessione viva fino a 30). */
const TOKEN_LIFETIME_MS = 30 * 60_000;
const TOKEN_NEW_SESSION_MS = 60_000;

/**
 * Crea un token temporaneo di Gemini Live monouso con tutta la configurazione fissata (`config` = setup senza `model`).
 * Forma REST verificata: nessun `fieldMask`. 15 s, nessun redirect; errori con messaggi fissi.
 */
export async function createEphemeralToken(
  model: ResolvedModel,
  config: Record<string, unknown>,
): Promise<{ token: string; expiresAt: string }> {
  if (!model.apiKey) throw new AlfredError(ALFRED_MESSAGES.geminiKeyRejected, 502);
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  const body = {
    uses: 1,
    expireTime: expiresAt,
    newSessionExpireTime: new Date(now + TOKEN_NEW_SESSION_MS).toISOString(),
    bidiGenerateContentSetup: { model: `models/${bareModelName(model.modelId)}`, ...config },
  };
  let res: Response;
  try {
    res = await fetch(`${geminiNativeBase()}/auth_tokens`, {
      method: "POST",
      headers: { "x-goog-api-key": model.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch {
    throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    logger.warn({ operation: "auth_tokens", status: res.status }, "Gemini ha rifiutato la richiesta");
    throw new AlfredError(ALFRED_MESSAGES.geminiKeyRejected, 502);
  }
  if (!res.ok) {
    logger.warn({ operation: "auth_tokens", status: res.status }, "Gemini ha risposto con un errore");
    throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  }
  let name: unknown;
  try {
    name = ((await res.json()) as { name?: unknown }).name;
  } catch {
    throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  }
  if (typeof name !== "string" || name === "") throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
  return { token: name, expiresAt };
}
