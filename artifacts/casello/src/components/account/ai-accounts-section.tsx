import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Star } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AiAccount,
  getListAiAccountsQueryKey,
  useDeleteAiAccount,
  useListAiAccounts,
  useSetDefaultAiAccount,
  useVerifyAiAccount,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { invalidateAiQueries } from "@/components/ai/ai-queries";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { AiAccountDialog, providerLabel } from "./ai-account-dialog";
import { AiModelsTable } from "./ai-models-table";

function AccountStatusBadge({ account }: { account: AiAccount }) {
  if (account.status === "ok") {
    return (
      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        verificato
      </Badge>
    );
  }
  if (account.status === "error") {
    return (
      <Badge variant="outline" className="border-transparent bg-red-100 whitespace-normal text-red-800 dark:bg-red-950 dark:text-red-300">
        errore: {account.lastError ?? "sconosciuto"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
      da verificare
    </Badge>
  );
}

function AccountRow({ account, onEdit, onDelete }: { account: AiAccount; onEdit: () => void; onDelete: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const verify = useVerifyAiAccount({
    mutation: {
      onSuccess: (verified) => {
        void invalidateAiQueries(queryClient);
        if (verified.status === "error") {
          toast({
            variant: "destructive",
            title: `Verifica di «${verified.name}» non riuscita`,
            description: verified.lastError ?? undefined,
          });
        } else {
          toast({ title: `Modelli aggiornati: ${verified.modelCount} modelli` });
        }
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Aggiornamento non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const setDefault = useSetDefaultAiAccount({
    mutation: {
      onSuccess: (saved) => {
        void invalidateAiQueries(queryClient);
        toast({ title: `Account predefinito: ${saved.name}` });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Impossibile impostare il predefinito", description: apiErrorMessage(error) }),
    },
  });

  const modelsId = `ai-account-models-${account.id}`;
  return (
    <li className="space-y-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {account.isDefault ? (
              <Star className="size-4 fill-amber-400 text-amber-500" aria-label="Account predefinito" role="img" />
            ) : null}
            <span className="truncate text-sm font-medium">{account.name}</span>
            {account.isSystem && <Badge variant="secondary">sistema</Badge>}
            <AccountStatusBadge account={account} />
          </div>
          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>{providerLabel(account.provider)}</span>
            <span>
              {account.modelCount} {account.modelCount === 1 ? "modello" : "modelli"}
            </span>
            <span>
              {account.lastCheckedAt ? `verificato ${formatRelative(account.lastCheckedAt)}` : "mai verificato"}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={modelsId}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            Modelli
          </Button>
          {!account.isSystem && (
            <>
              <Button variant="outline" size="sm" disabled={verify.isPending} onClick={() => verify.mutate({ id: account.id })}>
                {verify.isPending ? "Aggiornamento…" : "Aggiorna modelli"}
              </Button>
              {!account.isDefault && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={setDefault.isPending}
                  onClick={() => setDefault.mutate({ id: account.id })}
                >
                  Predefinito
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onEdit}>
                Modifica
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
                Elimina
              </Button>
            </>
          )}
        </div>
      </div>
      {expanded && (
        <div id={modelsId}>
          <AiModelsTable account={account} />
        </div>
      )}
    </li>
  );
}

/** Sezione "Account AI" della pagina Account: chiavi dei provider, modelli e prezzi dell'utente. */
export function AiAccountsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const accounts = useListAiAccounts({ query: { queryKey: getListAiAccountsQueryKey() } });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AiAccount | undefined>(undefined);
  const [deleting, setDeleting] = useState<AiAccount | null>(null);

  const deleteAccount = useDeleteAiAccount({
    mutation: {
      onSuccess: () => {
        void invalidateAiQueries(queryClient);
        toast({ title: "Account eliminato", description: deleting?.name });
        setDeleting(null);
      },
      onError: (error) => {
        setDeleting(null);
        // Il 409 elenca agenti e analisi che usano l'account
        toast({ variant: "destructive", title: "Impossibile eliminare l'account", description: apiErrorMessage(error) });
      },
    },
  });

  const openAdd = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Account AI</CardTitle>
          <CardDescription>
            Le tue chiavi dei provider di modelli: agenti e analisi che configuri usano (e pagano) l'account del
            modello scelto.
          </CardDescription>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus />
          Aggiungi account
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare gli account AI: {apiErrorMessage(accounts.error)}</p>
        ) : !accounts.data ? (
          <Skeleton className="h-16 w-full" />
        ) : accounts.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nessun account AI: aggiungine uno per scegliere i modelli di agenti e analisi.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {accounts.data.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                onEdit={() => {
                  setEditing(account);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(account)}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <AiAccountDialog open={dialogOpen} onOpenChange={setDialogOpen} account={editing} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Eliminare «${deleting?.name ?? ""}»?`}
        description="Verranno eliminati anche i suoi modelli e la chiave salvata. Non si può eliminare un account usato da agenti o analisi."
        pending={deleteAccount.isPending}
        onConfirm={() => deleting && deleteAccount.mutate({ id: deleting.id })}
      />
    </Card>
  );
}
