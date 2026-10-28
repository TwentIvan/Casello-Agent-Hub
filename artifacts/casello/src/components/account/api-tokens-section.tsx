import { useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ApiTokenInfo,
  getListApiTokensQueryKey,
  useCreateApiToken,
  useListApiTokens,
  useRevokeApiToken,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const MAX_NAME = 100;
const MCP_URL = "https://casello.fantamister.cloud/mcp";

const formatDate = (value: string) => new Date(value).toLocaleDateString("it-IT", { dateStyle: "short" });

/** Dialogo di creazione; a creazione riuscita passa il token al chiamante, che lo mostra una sola volta. */
function CreateTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [daysText, setDaysText] = useState(String(DEFAULT_DAYS));
  const days = Number(daysText);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
  const nameValid = name.trim().length > 0 && name.trim().length <= MAX_NAME;

  const create = useCreateApiToken({
    mutation: {
      onSuccess: (created) => {
        void queryClient.invalidateQueries({ queryKey: getListApiTokensQueryKey() });
        setName("");
        setDaysText(String(DEFAULT_DAYS));
        onCreated(created.token);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (nameValid && daysValid) create.mutate({ data: { name: name.trim(), expiresInDays: days } });
          }}
        >
          <DialogHeader>
            <DialogTitle>Nuovo token</DialogTitle>
            <DialogDescription>Un token per ogni computer o agente: puoi revocarlo in qualsiasi momento.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="token-name">Nome</Label>
            <Input
              id="token-name"
              value={name}
              maxLength={MAX_NAME}
              placeholder="es. MacBook di Ivan"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="token-days">Giorni di validità</Label>
            <Input
              id="token-days"
              type="number"
              min={1}
              max={MAX_DAYS}
              value={daysText}
              onChange={(e) => setDaysText(e.target.value)}
              aria-invalid={!daysValid}
            />
            {!daysValid && <p className="text-xs text-destructive">Inserisci un numero di giorni tra 1 e {MAX_DAYS}.</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={!nameValid || !daysValid || create.isPending}>
              {create.isPending ? "Creazione…" : "Crea token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Il token appena creato: vive solo nello stato del componente, mai in storage. */
function TokenRevealDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona il token e copialo a mano." });
    }
  };

  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Token creato</DialogTitle>
          <DialogDescription>Copialo ora: non sarà più visibile.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={token ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon" aria-label="Copia il token" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Fatto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiTokenInfo; onRevoke: () => void }) {
  const revoked = token.revokedAt !== null;
  const expired = !revoked && new Date(token.expiresAt).getTime() <= Date.now();
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{token.name}</span>
          {revoked && <Badge variant="secondary">revocato</Badge>}
          {expired && <Badge variant="secondary">scaduto</Badge>}
        </div>
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>creato {formatDate(token.createdAt)}</span>
          <span>scade {formatDate(token.expiresAt)}</span>
          <span>{token.lastUsedAt ? `ultimo uso ${formatRelative(token.lastUsedAt)}` : "mai usato"}</span>
          {revoked && token.revokedAt && <span>revocato {formatDate(token.revokedAt)}</span>}
        </div>
      </div>
      {!revoked && (
        <Button variant="outline" size="sm" className="text-destructive" onClick={onRevoke}>
          Revoca
        </Button>
      )}
    </li>
  );
}

/** Sezione "Agenti locali" della pagina Account: token personali per collegare Claude Code al server MCP di Casello. */
export function ApiTokensSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tokens = useListApiTokens({ query: { queryKey: getListApiTokensQueryKey() } });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiTokenInfo | null>(null);

  const revoke = useRevokeApiToken({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListApiTokensQueryKey() });
        toast({ title: "Token revocato", description: revoking?.name });
        setRevoking(null);
      },
      onError: (error) => {
        setRevoking(null);
        toast({ variant: "destructive", title: "Impossibile revocare il token", description: apiErrorMessage(error) });
      },
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Agenti locali</CardTitle>
          <CardDescription>
            Token personali con cui un agente Claude Code sul tuo computer prende in carico le analisi avviate con
            l'opzione «agente locale».
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Nuovo token
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {tokens.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare i token: {apiErrorMessage(tokens.error)}</p>
        ) : !tokens.data ? (
          <Skeleton className="h-16 w-full" />
        ) : tokens.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun token: creane uno per collegare un agente locale.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.data.map((token) => (
              <TokenRow key={token.id} token={token} onRevoke={() => setRevoking(token)} />
            ))}
          </ul>
        )}
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">Per collegare Claude Code, esegui sul tuo computer:</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {`claude mcp add --transport http casello ${MCP_URL} --header "Authorization: Bearer <token>"`}
          </pre>
        </div>
      </CardContent>
      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(token) => {
          setCreateOpen(false);
          setCreated(token);
        }}
      />
      <TokenRevealDialog token={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revocare il token?"
        description={`L'agente che usa «${revoking?.name ?? ""}» non potrà più collegarsi a Casello.`}
        confirmLabel="Revoca"
        pendingLabel="Revoca…"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ id: revoking.id })}
      />
    </Card>
  );
}
