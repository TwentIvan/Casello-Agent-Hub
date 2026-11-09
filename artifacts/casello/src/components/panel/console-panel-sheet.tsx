// Il pannello unico nella console: uno Sheet a destra, a schermo intero sul telefono e 440 px su desktop.
// La chiusura la offre il pannello («Chiudi»), quindi niente X dello Sheet.
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { BotcavePanel } from "./botcave-panel";
import { usePanel } from "./panel-context";

export function ConsolePanelSheet() {
  const { state, closePanel } = usePanel();
  return (
    <Sheet
      open={state.open}
      onOpenChange={(open) => {
        if (!open) closePanel();
      }}
    >
      <SheetContent side="right" hideClose className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        {/* Titolo per i lettori di schermo: quello visibile lo mostra il pannello */}
        <SheetTitle className="sr-only">Botcave</SheetTitle>
        <SheetDescription className="sr-only">Pannello di Alfred e Lucius</SheetDescription>
        <BotcavePanel />
      </SheetContent>
    </Sheet>
  );
}
