import { createContext, useContext, type ReactNode } from "react";
import { useAlfredVoice, type AlfredVoice } from "../alfred/use-alfred-voice";

// La voce di Alfred vive in un solo provider: cambiare scheda o chiudere il pannello non la interrompe.

const VoiceContext = createContext<AlfredVoice | null>(null);

export function AlfredVoiceProvider({ children }: { children: ReactNode }) {
  const voice = useAlfredVoice();
  return <VoiceContext.Provider value={voice}>{children}</VoiceContext.Provider>;
}

export function useSharedAlfredVoice(): AlfredVoice {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error("AlfredVoiceProvider mancante");
  return voice;
}
