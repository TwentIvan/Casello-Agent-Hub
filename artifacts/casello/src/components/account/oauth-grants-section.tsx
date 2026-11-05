import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type OAuthGrant,
  getListOAuthGrantsQueryKey,
  useListOAuthGrants,
  useRevokeOAuthGrant,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

/** Sezione «App collegate»: app come Claude che usano Casello su /mcp con OAuth. */
export function OAuthGrantsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const grants = useListOAuthGrants({ query: { queryKey: getListOAuthGrantsQueryKey() } });
  const [revoking, setRevoking] = useState<OAuthGrant | null>(null);
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;

  const revoke = useRevokeOAuthGrant({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListOAuthGrantsQueryKey() });
        toast({ title: "Collegamento revocato", description: revoking?.clientName });
        setRevoking(null);
      },
      onError: (error) => {
        setRevoking(null);
        toast({ variant: "destructive", title: "Impossibile revocare il collegamento", description: apiErrorMessage(error) });
      },
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona l'indirizzo e copialo a mano." });
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-1.5">
        <CardTitle>App collegate</CardTitle>
        <CardDescription>
          App come Claude che usano Casello tramite il connettore. Revocando un collegamento l'app smette di funzionare subito.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {grants.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare le app collegate: {apiErrorMessage(grants.error)}</p>
        ) : !grants.data ? (
          <Skeleton className="h-16 w-full" />
        ) : grants.data.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-muted-foreground">
              Nessuna app collegata. In claude.ai aggiungi il connettore{" "}
              <span className="break-all font-mono">{mcpUrl}</span>.
            </p>
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copiato" : "Copia indirizzo"}
            </Button>
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {grants.data.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{grant.clientName}</span>
                    <span className="break-all font-mono text-xs text-muted-foreground">{grant.redirectHost}</span>
                    {grant.canDecide && <Badge variant="secondary">Può approvare e rifiutare</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>collegato {formatRelative(grant.createdAt)}</span>
                    <span>{grant.lastUsedAt ? `ultimo uso ${formatRelative(grant.lastUsedAt)}` : "mai usato"}</span>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => setRevoking(grant)}>
                  Revoca
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revocare il collegamento?"
        description={`«${revoking?.clientName ?? ""}» non potrà più usare Casello finché non lo ricolleghi dal connettore.`}
        confirmLabel="Revoca"
        pendingLabel="Revoca…"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ id: revoking.id })}
      />
    </Card>
  );
}
