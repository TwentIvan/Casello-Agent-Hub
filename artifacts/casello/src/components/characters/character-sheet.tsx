import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { characterOf, type ChatTarget } from "./adapters";
import { CharacterChat } from "./character-chat";

interface CharacterSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ChatTarget;
  draft?: string;
  hasUnsavedChanges?: () => boolean;
}

/** Pannello laterale a destra: a schermo intero sul telefono, 440 px su desktop; la pagina sotto non si sposta. */
export function CharacterSheet({ open, onOpenChange, target, draft, hasUnsavedChanges }: CharacterSheetProps) {
  const name = characterOf(target) === "alfred" ? "Alfred" : "Lucius";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        {/* Titolo per i lettori di schermo: quello visibile lo mostra il pannello */}
        <SheetTitle className="sr-only">{name}</SheetTitle>
        <SheetDescription className="sr-only">Conversazione con {name}</SheetDescription>
        <CharacterChat target={target} draft={draft} hasUnsavedChanges={hasUnsavedChanges} layout="sheet" />
      </SheetContent>
    </Sheet>
  );
}
