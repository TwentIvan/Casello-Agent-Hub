import { getProviderIssue, useListCatalogProviders } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Riquadro dei provider scoperti nel catalogo ma non ancora gestiti da Casello; assente se non ce ne sono. */
export function UnmanagedProviders() {
  const { toast } = useToast();
  const providers = useListCatalogProviders({ status: "unmanaged" });
  const list = providers.data ?? [];
  if (list.length === 0) return null;

  const copyIssue = async (slug: string) => {
    try {
      const issue = await getProviderIssue(slug);
      await navigator.clipboard.writeText(`${issue.title}\n\n${issue.body}`);
      toast({ title: "Testo dell'issue copiato" });
    } catch (error) {
      toast({ variant: "destructive", title: apiErrorMessage(error) });
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
    </Card>
  );
}
