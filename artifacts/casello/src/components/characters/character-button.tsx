import { useRef } from "react";
import { AlfredMark, LuciusMark } from "@/components/brand/marks";
import { Button } from "@/components/ui/button";
import { characterOf, type ChatTarget } from "./adapters";
import { useCharacterPanel } from "./handoff-context";

interface CharacterButtonProps {
  target: ChatTarget;
  /** Modifiche non salvate nella pagina: accettare una scheda le farebbe perdere. */
  hasUnsavedChanges?: () => boolean;
}

/** «Chiedi a Lucius» / «Chiedi ad Alfred»: apre il pannello del personaggio sul bersaglio. */
export function CharacterButton({ target, hasUnsavedChanges }: CharacterButtonProps) {
  const { show } = useCharacterPanel();
  // Il pannello legge sempre il controllo più recente della pagina
  const latest = useRef(hasUnsavedChanges);
  latest.current = hasUnsavedChanges;
  const alfred = characterOf(target) === "alfred";

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => show(target, hasUnsavedChanges ? () => latest.current?.() ?? false : undefined)}
    >
      {alfred ? <AlfredMark size={12} /> : <LuciusMark size={12} />}
      {alfred ? "Chiedi ad Alfred" : "Chiedi a Lucius"}
    </Button>
  );
}
