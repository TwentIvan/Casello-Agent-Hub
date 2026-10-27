import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type LocalMachine,
  type LocalMachineCreated,
  type PersonalToken,
  type PersonalTokenCreated,
  getListLocalMachinesQueryKey,
  getListPersonalTokensQueryKey,
  useCreateLocalMachine,
  useCreatePersonalToken,
  useListLocalMachines,
  useListPersonalTokens,
  useRevokeLocalMachine,
  useRevokePersonalToken,
} from "@workspace/api-client-react";
import { invalidateAiQueries } from "@/components/ai/ai-queries";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const ONCE_WARNING = "Il token viene mostrato una sola volta: copialo ora, poi non si potrà più rileggere.";

/** Comando che avvia il runner sul computer (variabili d'ambiente come nel README del runner). */
function runnerCommand(origin: string, token: string): string {
  return `CASELLO_URL=${origin} \\\nCASELLO_RUNNER_TOKEN=${token} \\\npnpm --filter @workspace/casello-runner start`;
}

/** Comando di Claude Code per collegare la chat al server MCP di Casello. */
function mcpAddCommand(origin: string, token: string): string {
  return `claude mcp add --transport http casello ${origin}/api/mcp --header "Authorization: Bearer ${token}"`;
}

/** Configurazione di Claude Desktop (ponte mcp-remote; l'intestazione passa da una variabile). */
function desktopConfig(origin: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        casello: {
          command: "npx",
          args: ["-y", "mcp-remote", `${origin}/api/mcp`, "--header", "Authorization:${CASELLO_AUTH}"],
          env: { CASELLO_AUTH: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona il testo e copialo a mano." });
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copiato" : "Copia"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">{text}</pre>
    </div>
  );
}

/** Nome + "Registra": il valore resta nello stato finché la creazione non riesce. */
function NameForm({
  inputId,
  label,
  placeholder,
  submitLabel,
  pending,
  onSubmit,
}: {
  inputId: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  /** `onCreated` va chiamata solo a creazione riuscita: allora il campo si svuota. */
  onSubmit: (name: string, onCreated: () => void) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSubmit(trimmed, () => setName(""));
      }}
    >
      <div className="min-w-48 flex-1 space-y-1">
        <Label htmlFor={inputId}>{label}</Label>
        <Input id={inputId} value={name} maxLength={100} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button type="submit" disabled={!trimmed || pending}>
        {pending ? "Registrazione…" : submitLabel}
      </Button>
    </form>
  );
}

function MachineCreatedPanel({ created, onClose }: { created: LocalMachineCreated; onClose: () => void }) {
  const origin = window.location.origin;
  return (
    <Alert>
      <AlertTitle>Macchina «{created.machine.name}» registrata</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{ONCE_WARNING}</p>
        <CopyBlock label="Token della macchina" text={created.token} />
        <CopyBlock label="Comando per avviare il runner" text={runnerCommand(origin, created.token)} />
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Ho copiato il token
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function PersonalTokenCreatedPanel({ created, onClose }: { created: PersonalTokenCreated; onClose: () => void }) {
  const origin = window.location.origin;
  return (
    <Alert>
      <AlertTitle>Token «{created.personalToken.name}» creato</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{ONCE_WARNING}</p>
        <CopyBlock label="Token personale" text={created.token} />
        <CopyBlock label="Claude Code" text={mcpAddCommand(origin, created.token)} />
        <CopyBlock label="Claude Desktop (claude_desktop_config.json)" text={desktopConfig(origin, created.token)} />
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Ho copiato il token
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function seenLabel(lastSeenAt: string | null): string {
  return lastSeenAt ? `vista ${formatRelative(lastSeenAt)}` : "mai vista";
}

function MachineRow({ machine, onRevoke }: { machine: LocalMachine; onRevoke: () => void }) {
  const revoked = machine.revokedAt !== null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{machine.name}</span>
          {revoked ? (
            <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
              revocata
            </Badge>
          ) : machine.connected ? (
            <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              collegata
            </Badge>
          ) : (
            <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
              non collegata
            </Badge>
          )}
        </div>
        {!revoked && <div className="text-xs text-muted-foreground">{seenLabel(machine.lastSeenAt)}</div>}
      </div>
      {!revoked && (
        <Button variant="outline" size="sm" className="text-destructive" onClick={onRevoke}>
          Revoca
        </Button>
      )}
    </li>
  );
}

function TokenRow({ token, onRevoke }: { token: PersonalToken; onRevoke: () => void }) {
  const revoked = token.revokedAt !== null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{token.name}</span>
          {revoked && (
            <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
              revocato
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {token.lastUsedAt ? `usato ${formatRelative(token.lastUsedAt)}` : "mai usato"}
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

/** Sezione "Agenti locali" della pagina Account: macchine che eseguono i lavori e token personali per la chat. */
export function LocalAgentsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // I token appena creati vivono solo in questo stato: mai in storage né nei log
  const [createdMachine, setCreatedMachine] = useState<LocalMachineCreated | null>(null);
  const [createdToken, setCreatedToken] = useState<PersonalTokenCreated | null>(null);
  const [revokingMachine, setRevokingMachine] = useState<LocalMachine | null>(null);
  const [revokingToken, setRevokingToken] = useState<PersonalToken | null>(null);

  const machines = useListLocalMachines({
    query: { queryKey: getListLocalMachinesQueryKey(), refetchInterval: 10_000 },
  });
  const tokens = useListPersonalTokens({ query: { queryKey: getListPersonalTokensQueryKey() } });

  const createMachine = useCreateLocalMachine({
    mutation: {
      onSuccess: (created) => {
        setCreatedMachine(created);
        void queryClient.invalidateQueries({ queryKey: getListLocalMachinesQueryKey() });
        // La macchina è un nuovo modello dell'account "Agente locale"
        void invalidateAiQueries(queryClient);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Registrazione non riuscita", description: apiErrorMessage(error) }),
    },
  });
  const createToken = useCreatePersonalToken({
    mutation: {
      onSuccess: (created) => {
        setCreatedToken(created);
        void queryClient.invalidateQueries({ queryKey: getListPersonalTokensQueryKey() });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) }),
    },
  });
  const revokeMachine = useRevokeLocalMachine({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListLocalMachinesQueryKey() });
        void invalidateAiQueries(queryClient);
        toast({ title: "Macchina revocata", description: revokingMachine?.name });
        setRevokingMachine(null);
      },
      onError: (error) => {
        setRevokingMachine(null);
        toast({ variant: "destructive", title: "Revoca non riuscita", description: apiErrorMessage(error) });
      },
    },
  });
  const revokeToken = useRevokePersonalToken({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListPersonalTokensQueryKey() });
        toast({ title: "Token revocato", description: revokingToken?.name });
        setRevokingToken(null);
      },
      onError: (error) => {
        setRevokingToken(null);
        toast({ variant: "destructive", title: "Revoca non riuscita", description: apiErrorMessage(error) });
      },
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agenti locali</CardTitle>
        <CardDescription>
          Claude Code sul tuo computer esegue analisi e run con il tuo abbonamento: Casello gli dà solo i suoi strumenti.
          Ogni macchina registrata compare tra i modelli come «Agente locale · nome».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3" aria-labelledby="local-machines-title">
          <h3 id="local-machines-title" className="text-sm font-medium">
            Macchine
          </h3>
          {createdMachine && <MachineCreatedPanel created={createdMachine} onClose={() => setCreatedMachine(null)} />}
          {machines.isError ? (
            <p className="text-sm text-destructive">Impossibile caricare le macchine: {apiErrorMessage(machines.error)}</p>
          ) : !machines.data ? (
            <Skeleton className="h-16 w-full" />
          ) : machines.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna macchina registrata.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {machines.data.map((machine) => (
                <MachineRow key={machine.id} machine={machine} onRevoke={() => setRevokingMachine(machine)} />
              ))}
            </ul>
          )}
          <NameForm
            inputId="local-machine-name"
            label="Nome della nuova macchina"
            placeholder="es. MacBook di Ivan"
            submitLabel="Registra macchina"
            pending={createMachine.isPending}
            onSubmit={(name, onCreated) => createMachine.mutate({ data: { name } }, { onSuccess: onCreated })}
          />
        </section>

        <section className="space-y-3 border-t pt-6" aria-labelledby="local-tokens-title">
          <div className="space-y-1">
            <h3 id="local-tokens-title" className="text-sm font-medium">
              Token personali per la chat
            </h3>
            <p className="text-xs text-muted-foreground">
              Collegano Claude Code o Claude Desktop al server MCP di Casello: dalla chat prendi i lavori in coda.
            </p>
          </div>
          {createdToken && <PersonalTokenCreatedPanel created={createdToken} onClose={() => setCreatedToken(null)} />}
          {tokens.isError ? (
            <p className="text-sm text-destructive">Impossibile caricare i token: {apiErrorMessage(tokens.error)}</p>
          ) : !tokens.data ? (
            <Skeleton className="h-16 w-full" />
          ) : tokens.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessun token personale.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {tokens.data.map((token) => (
                <TokenRow key={token.id} token={token} onRevoke={() => setRevokingToken(token)} />
              ))}
            </ul>
          )}
          <NameForm
            inputId="personal-token-name"
            label="Nome del nuovo token"
            placeholder="es. Claude Desktop"
            submitLabel="Crea token"
            pending={createToken.isPending}
            onSubmit={(name, onCreated) => createToken.mutate({ data: { name } }, { onSuccess: onCreated })}
          />
        </section>
      </CardContent>
      <ConfirmDialog
        open={revokingMachine !== null}
        onOpenChange={(open) => !open && setRevokingMachine(null)}
        title={`Revocare «${revokingMachine?.name ?? ""}»?`}
        description="Il token della macchina smette di valere e il suo modello viene nascosto. I lavori in corso o in attesa su questa macchina falliscono. Gli agenti che lo usano vanno riconfigurati."
        confirmLabel="Revoca"
        pendingLabel="Revoca…"
        pending={revokeMachine.isPending}
        onConfirm={() => revokingMachine && revokeMachine.mutate({ id: revokingMachine.id })}
      />
      <ConfirmDialog
        open={revokingToken !== null}
        onOpenChange={(open) => !open && setRevokingToken(null)}
        title={`Revocare «${revokingToken?.name ?? ""}»?`}
        description="Le chat che usano questo token perdono l'accesso a Casello."
        confirmLabel="Revoca"
        pendingLabel="Revoca…"
        pending={revokeToken.isPending}
        onConfirm={() => revokingToken && revokeToken.mutate({ id: revokingToken.id })}
      />
    </Card>
  );
}
