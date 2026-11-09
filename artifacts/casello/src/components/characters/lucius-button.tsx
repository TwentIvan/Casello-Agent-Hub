import { LuciusMark } from "@/components/brand/marks";
import { Button } from "@/components/ui/button";
import { usePanel } from "@/components/panel/panel-context";

/** «Chiedi a Lucius»: apre il pannello unico sulla scheda di Lucius (l'argomento lo dichiara la pagina). */
export function LuciusButton() {
  const { openPanel } = usePanel();
  return (
    <Button variant="outline" size="sm" onClick={() => openPanel("lucius", { clearOverride: true })}>
      <LuciusMark size={12} />
      Chiedi a Lucius
    </Button>
  );
}
