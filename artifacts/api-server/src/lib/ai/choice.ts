import { ProviderError } from "./discovery";
import { ModelAccessError, resolveModel } from "./executor";

/**
 * Scelta del modello da parte di un utente (agenti, analisi). Regola "chi configura paga": si può
 * scegliere solo un modello dei propri account o dell'account di sistema; chi esegue (run, analisi)
 * usa poi il modello salvato, chiunque la avvii.
 */

export interface ModelChoice {
  aiModelId: number | null;
  /** Id del modello come testo, salvato nella colonna `model` per compatibilità. */
  model: string;
}

/** Nessun modello: il testo storico `agents.model` (NOT NULL) resta vuoto. */
export const NO_MODEL: ModelChoice = { aiModelId: null, model: "" };

/** Scelta non ammessa: il messaggio è già in italiano e sicuro da restituire (400). */
export class ModelChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelChoiceError";
  }
}

export const MODEL_UNAVAILABLE = "modello non disponibile";

/**
 * Modello scelto dall'utente: deve essere suo o dell'account di sistema (configurato). La chiave
 * eventualmente decifrata da `resolveModel` resta in questa funzione e non viene restituita.
 */
export async function chooseOwnModel(aiModelId: number, userId: number): Promise<ModelChoice> {
  if (!Number.isSafeInteger(aiModelId) || aiModelId <= 0) throw new ModelChoiceError(MODEL_UNAVAILABLE);
  try {
    const resolved = await resolveModel(aiModelId, { userId, mustOwn: true });
    return { aiModelId: resolved.aiModelId, model: resolved.modelId };
  } catch (err) {
    if (err instanceof ModelAccessError || err instanceof ProviderError) throw new ModelChoiceError(err.message);
    throw err;
  }
}
