import { useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ApiTokenInfo,
  ApiTokenScope,
  getListApiTokensQueryKey,
  useCreateApiToken,
  useListApiTokens,
  useRevokeApiToken,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const SCOPE_LABELS: Record<ApiTokenScope, string> = {
  mcp: "Agente locale (MCP)",
  "api:read": "API: lettura",
  "api:write": "API: scrittura",
};
const SCOPE_ORDER: ApiTokenScope[] = ["mcp", "api:read", "api:write"];

const formatDate = (value: string) => new Date(value).toLocaleDateString("it-IT", { dateStyle: "short" });

/** Dialogo di creazione; a creazione riuscita passa il token al chiamante, che lo mostra una sola volta. */
function CreateTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: { token: string; scopes: ApiTokenScope[] }) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [daysText, setDaysText] = useState(String(DEFAULT_DAYS));
  const [mcp, setMcp] = useState(true);
  const [read, setRead] = useState(false);
  const [write, setWrite] = useState(false);
  const days = Number(daysText);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
  const scopes = SCOPE_ORDER.filter((scope) =>
    scope === "mcp" ? mcp : scope === "api:read" ? read || write : write,
  );
  const nameValid = name.trim().length > 0 && name.trim().length <= MAX_NAME;

  const create = useCreateApiToken({
    mutation: {
      onSuccess: (created, variables) => {
        void queryClient.invalidateQueries({ queryKey: getListApiTokensQueryKey() });
        setName("");
        setDaysText(String(DEFAULT_DAYS));
        setMcp(true);
        setRead(false);
        setWrite(false);
        onCreated({ token: created.token, scopes: variables.data.scopes ?? scopes });
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
            if (nameValid && daysValid && scopes.length > 0)
              create.mutate({ data: { name: name.trim(), expiresInDays: days, scopes } });
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
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium leading-none">Cosa può fare</legend>
            <div className="flex items-center gap-2">
              <Checkbox id="scope-mcp" checked={mcp} onCheckedChange={(v) => setMcp(v === true)} />
              <Label htmlFor="scope-mcp" className="font-normal">{SCOPE_LABELS.mcp}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="scope-read"
                checked={read || write}
                disabled={write}
                onCheckedChange={(v) => setRead(v === true)}
              />
              <Label htmlFor="scope-read" className="font-normal">{SCOPE_LABELS["api:read"]}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="scope-write"
                checked={write}
                onCheckedChange={(v) => {
                  setWrite(v === true);
                  if (v === true) setRead(true);
                }}
              />
              <Label htmlFor="scope-write" className="font-normal">{SCOPE_LABELS["api:write"]}</Label>
            </div>
            {scopes.length === 0 && <p className="text-xs text-destructive">Scegli almeno un ambito.</p>}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annulla
            </Button>
            <Button type="submit" disabled={!nameValid || !daysValid || scopes.length === 0 || create.isPending}>
              {create.isPending ? "Creazione…" : "Crea token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Il token appena creato: vive solo nello stato del componente, mai in storage. */
function TokenRevealDialog({
  created,
  onClose,
}: {
  created: { token: string; scopes: ApiTokenScope[] } | null;
  onClose: () => void;
}) {
  const token = created?.token ?? null;
  const hasMcp = created?.scopes.includes("mcp") ?? false;
  const hasApi = created?.scopes.some((scope) => scope.startsWith("api:")) ?? false;
  const origin = window.location.origin;
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
      {/* Il token si vede una sola volta: si chiude solo con «Fatto», non con Esc o un clic fuori */}
      <DialogContent onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Token creato</DialogTitle>
          <DialogDescription>Copialo ora: non sarà più visibile.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly aria-label="Token" value={token ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon" aria-label="Copia il token" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        {hasMcp && (
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">Per collegare Claude Code, esegui sul tuo computer:</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {`claude mcp add --scope user --transport http casello ${origin}/mcp --header "Authorization: Bearer ${token ?? "<token>"}"`}
            </pre>
          </div>
        )}
        {hasApi && (
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">Per provare l'API:</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {`curl -H "Authorization: Bearer ${token ?? "<token>"}" ${origin}/api/auth/me`}
            </pre>
          </div>
        )}
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
          {SCOPE_ORDER.filter((scope) => token.scopes.includes(scope)).map((scope) => (
            <Badge key={scope} variant="outline">{SCOPE_LABELS[scope]}</Badge>
          ))}
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

/** Sezione "Token personali" della pagina Account: accesso a Casello da agenti locali (MCP) e dall'API. */
export function ApiTokensSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tokens = useListApiTokens({ query: { queryKey: getListApiTokensQueryKey() } });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<{ token: string; scopes: ApiTokenScope[] } | null>(null);
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
          <CardTitle>Token personali</CardTitle>
          <CardDescription>
            Token con cui un agente Claude Code sul tuo computer prende in carico le analisi (agente locale) o con cui
            uno script chiama l'API di Casello, in sola lettura o anche in scrittura.
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
          <p className="text-sm text-muted-foreground">Nessun token: creane uno per collegare un agente locale o usare l'API.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {tokens.data.map((token) => (
              <TokenRow key={token.id} token={token} onRevoke={() => setRevoking(token)} />
            ))}
          </ul>
        )}
      </CardContent>
      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(result) => {
          setCreateOpen(false);
          setCreated(result);
        }}
      />
      <TokenRevealDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revocare il token?"
        description={`L'agente che usa «${revoking?.name ?? ""}» non potrà più accedere a Casello.`}
        confirmLabel="Revoca"
        pendingLabel="Revoca…"
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ id: revoking.id })}
      />
    </Card>
  );
}
