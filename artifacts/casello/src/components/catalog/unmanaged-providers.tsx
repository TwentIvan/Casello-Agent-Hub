import { useState } from "react";
import { getProviderIssue, useListCatalogProviders } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Oltre questo numero di provider il riquadro parte compresso. */
const COLLAPSED_COUNT = 5;

/**
 * Riquadro dei provider scoperti nel catalogo ma non ancora riconosciuti nel registro di Casello; assente se
 * non ce ne sono. Con più di 5 provider mostra i primi 5 e il pulsante per vederli tutti.
 */
export function UnmanagedProviders() {
  const { toast } = useToast();
  const providers = useListCatalogProviders({ status: "unmanaged" });
  // Testo dell'issue da copiare a mano quando gli appunti non sono disponibili
  const [manualText, setManualText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const list = providers.data ?? [];
  if (list.length === 0) return null;
  const shown = expanded ? list : list.slice(0, COLLAPSED_COUNT);

  const copyIssue = async (slug: string) => {
    let text: string;
    try {
      const issue = await getProviderIssue(slug);
      text = `${issue.title}\n\n${issue.body}`;
    } catch (error) {
      toast({ variant: "destructive", title: apiErrorMessage(error) });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Testo dell'issue copiato" });
    } catch {
      toast({ variant: "destructive", title: "Impossibile copiare negli appunti" });
      setManualText(text);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Da gestire in Casello</CardTitle>
        <p className="text-sm text-muted-foreground">
          Provider presenti nel catalogo che Casello non riconosce ancora nel registro. Puoi già usarli creando
          un account compatibile OpenAI e inserendo il loro indirizzo; per farli riconoscere copia il testo
          dell'issue.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {shown.map((p) => (
            <li key={p.slug} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {p.modelCount} {p.modelCount === 1 ? "modello" : "modelli"} · comparso il {new Date(p.firstSeenAt).toLocaleDateString("it-IT")}
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={() => void copyIssue(p.slug)}>
                Copia testo issue
              </Button>
            </li>
          ))}
        </ul>
        {list.length > COLLAPSED_COUNT && (
          <Button variant="link" size="sm" className="px-0" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Mostra meno" : `Mostra tutti (${list.length})`}
          </Button>
        )}
      </CardContent>
      <Dialog open={manualText !== null} onOpenChange={(open) => !open && setManualText(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Testo dell'issue</DialogTitle>
            <DialogDescription>Copialo a mano: gli appunti non sono disponibili.</DialogDescription>
          </DialogHeader>
          <Textarea aria-label="Testo dell'issue" readOnly rows={12} value={manualText ?? ""} onFocus={(e) => e.target.select()} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}
