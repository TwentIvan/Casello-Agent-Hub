import { useState } from "react";
import { getProviderIssue, useListCatalogProviders } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Riquadro dei provider scoperti nel catalogo ma non ancora gestiti da Casello; assente se non ce ne sono. */
export function UnmanagedProviders() {
  const { toast } = useToast();
  const providers = useListCatalogProviders({ status: "unmanaged" });
  // Testo dell'issue da copiare a mano quando gli appunti non sono disponibili
  const [manualText, setManualText] = useState<string | null>(null);
  const list = providers.data ?? [];
  if (list.length === 0) return null;

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
          Provider presenti nel catalogo ma non ancora collegabili con un account.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {list.map((p) => (
            <li key={p.slug} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {p.modelCount} voci · comparso il {new Date(p.firstSeenAt).toLocaleDateString("it-IT")}
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={() => void copyIssue(p.slug)}>
                Copia testo issue
              </Button>
            </li>
          ))}
        </ul>
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
