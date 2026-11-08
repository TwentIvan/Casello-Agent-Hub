import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  type Agent,
  type Trigger,
  getListAgentTriggersQueryKey,
  getListAppToolsQueryKey,
  getListTriggerRunsQueryKey,
  useDeleteTrigger,
  useListAgentTriggers,
  useListAppTools,
  useListTriggerRuns,
  usePauseTrigger,
  useRegenerateTriggerSecret,
  useResumeTrigger,
  useSetTriggerSigningSecret,
} from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";
import { TriggerDialog } from "./trigger-dialog";
import { SigningSecretDialog, WebhookUrlDialog } from "./webhook-url-dialog";

export const HOSTILE_CONTENT_WARNING =
  "Il contenuto degli inneschi può contenere istruzioni ostili: attiva la conferma delle scritture.";

const LED: Record<Trigger["status"], { state: LedState; label: string }> = {
  active: { state: "ok", label: "Attivo" },
  paused: { state: "idle", label: "In pausa" },
  error: { state: "ko", label: "In errore" },
};

function intervalLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 && minutes % 60 === 0 ? `ogni ${minutes / 60} h` : `ogni ${minutes} min`;
}

/** Ultime run di un innesco (caricate solo quando si aprono). */
function TriggerRuns({ triggerId }: { triggerId: number }) {
  const runs = useListTriggerRuns(triggerId, { query: { queryKey: getListTriggerRunsQueryKey(triggerId) } });
  if (runs.isLoading) return <Skeleton className="h-5 w-40" />;
  if (runs.isError) return <p className="text-xs text-danger">{apiErrorMessage(runs.error)}</p>;
  const latest = (runs.data ?? []).slice(0, 5);
  if (latest.length === 0) return <p className="text-xs text-ink-muted">Nessuna run avviata da questo innesco.</p>;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {latest.map((run) => (
        <li key={run.id}>
          <Link href={`/runs/${run.id}`} className="font-mono font-medium hover:underline">
            run {run.id}
          </Link>{" "}
          <span className="text-ink-muted">{formatRelative(run.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function TriggerRow({
  trigger,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onRegenerate,
  onSetSecret,
  onClearSecret,
}: {
  trigger: Trigger;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRegenerate: () => void;
  onSetSecret: () => void;
  onClearSecret: () => void;
}) {
  const [showRuns, setShowRuns] = useState(false);
  const led = LED[trigger.status];
  const isPoll = trigger.kind === "poll";
  const toggleLabel = trigger.status === "active" ? "Pausa" : trigger.status === "error" ? "Riprendi" : "Attiva";
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="break-words font-medium">{trigger.name}</span>
            <Led state={led.state} label={led.label} />
          </div>
          <p className="text-xs text-ink-muted">
            {isPoll ? "Sorveglianza" : "Webhook"}
            {isPoll && trigger.intervalSeconds !== null && ` · ${intervalLabel(trigger.intervalSeconds)}`}
            {" · "}
            {isPoll ? "ultimo giro" : "ultimo evento"}{" "}
            {trigger.lastPolledAt ? formatRelative(trigger.lastPolledAt) : "mai"}
            {" · "}
            <span className="font-mono tabular-nums">{trigger.runsCreated}</span> run create
            {!isPoll && trigger.signingSecretSet && " · firma attiva"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={trigger.status === "active" ? "outline" : "default"} disabled={busy} onClick={onToggle}>
            {toggleLabel}
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            Modifica
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            Elimina
          </Button>
        </div>
      </div>
      {trigger.lastError && (
        <p className="break-words text-xs text-danger">
          Ultimo errore: {trigger.lastError}
          {trigger.consecutiveErrors > 0 && (
            <>
              {" "}
              (<span className="font-mono tabular-nums">{trigger.consecutiveErrors}</span> di fila)
            </>
          )}
        </p>
      )}
      {!isPoll && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={onRegenerate}>
            Rigenera indirizzo
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onSetSecret}>
            {trigger.signingSecretSet ? "Cambia segreto di firma" : "Imposta segreto di firma"}
          </Button>
          {trigger.signingSecretSet && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onClearSecret}>
              Togli segreto di firma
            </Button>
          )}
        </div>
      )}
      <div>
        <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => setShowRuns((prev) => !prev)}>
          {showRuns ? "Nascondi le ultime run" : "Ultime run"}
        </Button>
        {showRuns && (
          <div className="mt-1">
            <TriggerRuns triggerId={trigger.id} />
          </div>
        )}
      </div>
    </li>
  );
}

/** Inneschi dell'agente: sorveglianza di un tool o webhook che avviano una run. */
export function AgentTriggersSection({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const triggers = useListAgentTriggers(agent.id, { query: { queryKey: getListAgentTriggersQueryKey(agent.id) } });
  const tools = useListAppTools(agent.appId, { query: { queryKey: getListAppToolsQueryKey(agent.appId) } });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Trigger | null>(null);
  const [deleting, setDeleting] = useState<Trigger | null>(null);
  const [regenerating, setRegenerating] = useState<Trigger | null>(null);
  const [clearing, setClearing] = useState<Trigger | null>(null);
  const [secretFor, setSecretFor] = useState<Trigger | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListAgentTriggersQueryKey(agent.id) });
  const fail = (title: string) => (error: unknown) =>
    toast({ variant: "destructive", title, description: apiErrorMessage(error) });

  const pause = usePauseTrigger({ mutation: { onSuccess: () => void refresh(), onError: fail("Operazione non riuscita") } });
  const resume = useResumeTrigger({ mutation: { onSuccess: () => void refresh(), onError: fail("Operazione non riuscita") } });
  const remove = useDeleteTrigger({
    mutation: {
      onSuccess: () => {
        void refresh();
        setDeleting(null);
        toast({ title: "Innesco eliminato" });
      },
      onError: fail("Eliminazione non riuscita"),
    },
  });
  const regenerate = useRegenerateTriggerSecret({
    mutation: {
      onSuccess: (result) => {
        setRegenerating(null);
        setWebhookUrl(result.webhookUrl);
      },
      onError: fail("Rigenerazione non riuscita"),
    },
  });
  const clearSecret = useSetTriggerSigningSecret({
    mutation: {
      onSuccess: () => {
        void refresh();
        setClearing(null);
        toast({ title: "Segreto di firma tolto" });
      },
      onError: fail("Operazione non riuscita"),
    },
  });

  // Avviso fisso: tool L1 (scritture) in uso e conferma delle scritture spenta. Il generale usa tutti i tool attivi dell'app.
  const hasL1Tools = useMemo(
    () =>
      (tools.data ?? []).some(
        (tool) =>
          tool.status === "active" &&
          (tool.levelOverride ?? tool.level) === "L1" &&
          (agent.role === "general" || agent.toolIds.includes(tool.id)),
      ),
    [tools.data, agent.role, agent.toolIds],
  );
  const showWarning = hasL1Tools && !agent.confirmWrites;
  const busy = pause.isPending || resume.isPending || regenerate.isPending || clearSecret.isPending;

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const list = triggers.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Inneschi</CardTitle>
          <CardDescription>
            Avviano una run dell'agente da soli: una sorveglianza interroga un tool a intervalli, un webhook riceve chiamate da fuori. Un innesco nuovo nasce in pausa:
            provalo e attivalo.
          </CardDescription>
        </div>
        <Button size="sm" onClick={openNew}>
          Nuovo innesco
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {showWarning && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>{HOSTILE_CONTENT_WARNING}</AlertDescription>
          </Alert>
        )}
        {triggers.isError ? (
          <p className="text-sm text-danger">Impossibile caricare gli inneschi: {apiErrorMessage(triggers.error)}</p>
        ) : triggers.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : list.length === 0 ? (
          <p className="text-sm text-ink-muted">Nessun innesco: l'agente parte solo quando lo lanci tu o un'app.</p>
        ) : (
          <ul className="divide-y">
            {list.map((trigger) => (
              <TriggerRow
                key={trigger.id}
                trigger={trigger}
                busy={busy}
                onToggle={() => (trigger.status === "active" ? pause : resume).mutate({ id: trigger.id })}
                onEdit={() => {
                  setEditing(trigger);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(trigger)}
                onRegenerate={() => setRegenerating(trigger)}
                onSetSecret={() => setSecretFor(trigger)}
                onClearSecret={() => setClearing(trigger)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <TriggerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        agent={agent}
        tools={tools.data ?? []}
        trigger={editing}
        onWebhookCreated={setWebhookUrl}
      />
      <WebhookUrlDialog url={webhookUrl} onClose={() => setWebhookUrl(null)} />
      <SigningSecretDialog trigger={secretFor} onClose={() => setSecretFor(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Eliminare «${deleting?.name ?? ""}»?`}
        description="L'innesco smette di avviare run. Le run già avviate restano. L'operazione non si può annullare."
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
      />
      <ConfirmDialog
        open={regenerating !== null}
        onOpenChange={(open) => !open && setRegenerating(null)}
        title="Rigenerare l'indirizzo?"
        description="Il vecchio indirizzo smette di funzionare subito: chi lo usa va aggiornato con quello nuovo, che vedrai una sola volta."
        confirmLabel="Rigenera indirizzo"
        pendingLabel="Rigenerazione…"
        pending={regenerate.isPending}
        onConfirm={() => regenerating && regenerate.mutate({ id: regenerating.id })}
      />
      <ConfirmDialog
        open={clearing !== null}
        onOpenChange={(open) => !open && setClearing(null)}
        title="Togliere il segreto di firma?"
        description="Il webhook accetterà le chiamate anche senza firma, purché portino l'indirizzo giusto."
        confirmLabel="Togli segreto"
        pendingLabel="Salvataggio…"
        pending={clearSecret.isPending}
        onConfirm={() => clearing && clearSecret.mutate({ id: clearing.id, data: { secret: null } })}
      />
    </Card>
  );
}
