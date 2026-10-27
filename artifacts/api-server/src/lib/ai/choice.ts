import { isLocalModel, isMachineActive } from "../local/machines";
import { ProviderError } from "./discovery";
import { ModelAccessError, resolveModel } from "./executor";
import { findUsableSystemModelId } from "./system-account";

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

/** Scelta non ammessa: il messaggio è già in italiano e sicuro da restituire (400). */
export class ModelChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelChoiceError";
  }
}

const MODEL_UNAVAILABLE = "modello non disponibile";
export const FALLBACK_REQUIRED = "modello di riserva obbligatorio con l'agente locale";
const FALLBACK_NOT_API = "il modello di riserva deve essere un modello API";

/**
 * Modello scelto dall'utente: deve essere suo o dell'account di sistema (configurato); una macchina
 * dell'agente locale solo se non è revocata. La chiave eventualmente decifrata da `resolveModel` resta
 * in questa funzione e non viene restituita.
 */
export async function chooseOwnModel(aiModelId: number, userId: number): Promise<ModelChoice> {
  if (!Number.isSafeInteger(aiModelId) || aiModelId <= 0) throw new ModelChoiceError(MODEL_UNAVAILABLE);
  let choice: ModelChoice;
  let local: boolean;
  try {
    const resolved = await resolveModel(aiModelId, { userId, mustOwn: true });
    choice = { aiModelId: resolved.aiModelId, model: resolved.modelId };
    local = resolved.kind === "local_agent";
  } catch (err) {
    if (err instanceof ModelAccessError || err instanceof ProviderError) throw new ModelChoiceError(err.message);
    throw err;
  }
  if (local) {
    const machine = await isLocalModel(aiModelId);
    if (!machine || !(await isMachineActive(machine.machineId, userId))) throw new ModelChoiceError(MODEL_UNAVAILABLE);
  }
  return choice;
}

/** Modello di riserva: un modello API dell'utente o dell'account di sistema, mai un agente locale. */
export async function chooseFallbackModel(aiModelId: number, userId: number): Promise<number> {
  const choice = await chooseOwnModel(aiModelId, userId);
  if (await isLocalModel(aiModelId)) throw new ModelChoiceError(FALLBACK_NOT_API);
  return choice.aiModelId!;
}

/**
 * Riserva di un modello appena scelto (avvio di un'analisi, creazione di un agente): con un agente locale è
 * obbligatoria e validata; con un modello API è ignorata (null).
 */
export async function fallbackFor(choice: ModelChoice, fallbackAiModelId: number | null | undefined, userId: number): Promise<number | null> {
  if (choice.aiModelId === null || !(await isLocalModel(choice.aiModelId))) return null;
  if (fallbackAiModelId == null) throw new ModelChoiceError(FALLBACK_REQUIRED);
  return chooseFallbackModel(fallbackAiModelId, userId);
}

/**
 * Transizione: modello indicato solo per nome (console precedente). Se l'account di sistema ha un
 * modello con quell'id (ed è configurato) lo si collega, altrimenti resta il vecchio percorso del gateway (null).
 */
export async function chooseByName(model: string): Promise<ModelChoice> {
  return { aiModelId: await findUsableSystemModelId(model), model };
}
