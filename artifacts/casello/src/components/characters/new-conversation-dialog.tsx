import { useEffect, useState } from "react";
import { getGetCharacterSettingsQueryKey, useGetCharacterSettings } from "@workspace/api-client-react";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Character } from "./adapters";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  character: Character;
  pending: boolean;
  onCreate: (modelId: number) => void;
}

/** Scelta del modello per una conversazione nuova: si propone quello del personaggio, poi il predefinito dell'utente. */
export function NewConversationDialog({ open, onOpenChange, character, pending, onCreate }: Props) {
  const settings = useGetCharacterSettings({ query: { queryKey: getGetCharacterSettingsQueryKey() } });
  const accountDefault = useDefaultAiModelId();
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  // Comunque si chiuda (Annulla, creazione riuscita, Esc), la prossima apertura riparte dal modello proposto
  useEffect(() => {
    if (!open) setChosen(undefined);
  }, [open]);
  const characterModel =
    character === "alfred" ? settings.data?.alfredChatAiModelId : settings.data?.luciusAiModelId;
  const modelId = chosen !== undefined ? chosen : (characterModel ?? accountDefault);
  const name = character === "alfred" ? "Alfred" : "Lucius";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuova conversazione con {name}</DialogTitle>
          <DialogDescription>Scegli il modello di questa conversazione.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="new-conversation-model">Modello</Label>
          <ModelPicker id="new-conversation-model" value={modelId} onChange={setChosen} disabled={pending} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Annulla
          </Button>
          <Button disabled={modelId === null || pending} onClick={() => modelId !== null && onCreate(modelId)}>
            {pending ? "Creazione…" : "Crea la conversazione"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
