// Modelli solo vocali o audio (Gemini Live, audio nativo, trascrizione, sintesi vocale, realtime): non rispondono alle
// chiamate di chat. L'API li segna non selezionabili (`isAudioOnlyModel` in `lib/ai/model-status.ts`, stessa regola);
// qui si tolgono anche da «Altri modelli» delle tendine.

const AUDIO_ONLY_RE = /(^|[-_./:])(live|audio|tts|transcribe|realtime)([-_./:]|$)/i;

export const isAudioOnlyModel = (modelId: string): boolean => AUDIO_ONLY_RE.test(modelId);

/** «Altri modelli» della tendina: disponibili ma senza strumenti, esclusi quelli solo audio. */
export function otherModels<M extends { modelId: string; status: string; supportsTools: boolean | null }>(models: M[]): M[] {
  return models.filter((m) => m.status === "available" && m.supportsTools === false && !isAudioOnlyModel(m.modelId));
}
