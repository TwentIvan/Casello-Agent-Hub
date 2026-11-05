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
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new AlfredError(ALFRED_MESSAGES.geminiKeyRejected, 502);
  if (!res.ok) throw new AlfredError(ALFRED_MESSAGES.geminiUnreachable, 502);
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
