import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Node,
  type NodeClaudeStatus,
  getGetNodeDiagnosticsUrl,
  getListNodesQueryKey,
  useRequestNodeDiagnostics,
  useRequestNodeUninstall,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Led, type LedState } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { NodeSettingsDialog } from "@/components/account/node-settings-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

/** Testo degli avvisi su Claude Code di un nodo (Dashboard e carta dell'account «Claude Code (nodo)»). */
export const CLAUDE_WARNING_TEXT = {
  not_installed: "Claude Code non è installato",
  not_logged_in: "Claude Code non ha l'accesso fatto",
  login_expiring: "l'accesso di Claude Code sta per scadere",
} as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("it-IT", { dateStyle: "medium" });
}

/** LED e testo dello stato di Claude Code sul Mac. */
export function claudeStatusLed(claude: NodeClaudeStatus | null): { state: LedState; label: string } | null {
  if (!claude) return null;
  if (!claude.found) return { state: "ko", label: "Claude Code non installato" };
  const version = claude.version ? ` · ${claude.version}` : "";
  if (claude.loggedIn === false) return { state: "ask", label: `installato${version} · accesso non fatto` };
  if (claude.loggedIn) {
    const plan = claude.subscriptionType ? ` · ${claude.subscriptionType}` : "";
    const expires = claude.loginExpiresAt ? ` · scade il ${formatDate(claude.loginExpiresAt)}` : "";
    return { state: "ok", label: `installato${version} · accesso fatto${plan}${expires}` };
  }
  return { state: "idle", label: `installato${version}` };
}

/** Stato di Claude Code, avvisi di versione e della diagnosi di un nodo. */
export function NodeStatusDetails({ node }: { node: Node }) {
  const claude = claudeStatusLed(node.claude);
  const notices: string[] = [];
  if (node.belowMinVersion) {
    notices.push("Versione troppo vecchia: il nodo non riceve lavoro finché non si aggiorna.");
  }
  if (node.kind === "cli") {
    notices.push("Installa Botcave Nodo per gli aggiornamenti automatici.");
  } else if (node.updateAvailable) {
    notices.push(`Aggiornamento disponibile: versione ${node.updateAvailable}.`);
  }
  if (node.updateFailedVersion) {
    notices.push(`L'aggiornamento alla versione ${node.updateFailedVersion} non è riuscito.`);
  }
  if (node.kind === "app" && node.status === "disabled") {
    notices.push("Nodo disattivato: per usare di nuovo questo Mac apri Botcave Nodo e scegli Ricollega (crea un nodo nuovo).");
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {claude && (
        <div className="flex flex-wrap items-center gap-x-3">
          <Led state={claude.state} label={claude.label} />
          {node.claudeCheckedAt && <span>controllato {formatRelative(node.claudeCheckedAt)}</span>}
        </div>
      )}
      {node.gitStatus && (
        <div className="flex flex-wrap items-center gap-x-3">
          <Led
            state={node.gitStatus.found ? "ok" : "ko"}
            label={node.gitStatus.found ? `Git: installato${node.gitStatus.version ? ` · ${node.gitStatus.version}` : ""}` : "Git non installato"}
          />
        </div>
      )}
      {notices.map((text) => (
        <p key={text} className="text-ink">
          {text}
        </p>
      ))}
      {node.uninstallRequestedAt && <p>Disinstallazione richiesta {formatRelative(node.uninstallRequestedAt)}.</p>}
    </div>
  );
}

/** Impostazioni, diagnosi e disinstallazione di un nodo. */
export function NodeExtraActions({ node }: { node: Node }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListNodesQueryKey() });

  const diagnostics = useRequestNodeDiagnostics({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Diagnosi richiesta", description: "Il nodo la invia al prossimo contatto." });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Richiesta non riuscita", description: apiErrorMessage(error) }),
    },
  });
  const uninstall = useRequestNodeUninstall({
    mutation: {
      onSuccess: () => {
        refresh();
        setUninstalling(false);
        toast({ title: "Disinstallazione richiesta", description: "Il nodo la esegue al prossimo contatto." });
      },
      onError: (error) => {
        setUninstalling(false);
        toast({ variant: "destructive", title: "Richiesta non riuscita", description: apiErrorMessage(error) });
      },
    },
  });

  const active = node.status === "active";
  return (
    <>
      {active && (
        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
          Impostazioni
        </Button>
      )}
      {node.diagnosticsAt && (
        // Download dello stesso sito con la sessione: un collegamento, non una lettura dati
        <Button asChild variant="outline" size="sm">
          <a href={getGetNodeDiagnosticsUrl(node.id)} download>
            Scarica diagnosi
          </a>
        </Button>
      )}
      {active && (
        <Button
          variant="outline"
          size="sm"
          disabled={diagnostics.isPending || (node.diagnosticsRequestedAt !== null && !node.diagnosticsAt)}
          onClick={() => diagnostics.mutate({ id: node.id })}
        >
          {node.diagnosticsRequestedAt && !node.diagnosticsAt ? "Diagnosi richiesta" : "Richiedi diagnosi"}
        </Button>
      )}
      {active && node.kind === "app" && (
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={node.uninstallRequestedAt !== null}
          onClick={() => setUninstalling(true)}
        >
          Disinstalla dal Mac
        </Button>
      )}
      <NodeSettingsDialog node={settingsOpen ? node : null} onClose={() => setSettingsOpen(false)} />
      <ConfirmDialog
        open={uninstalling}
        onOpenChange={setUninstalling}
        title="Disinstallare Botcave Nodo dal Mac?"
        description={`«${node.name}» toglie l'app, il servizio e la configurazione dal Mac al prossimo contatto e il nodo smette di ricevere compiti.`}
        confirmLabel="Disinstalla"
        pendingLabel="Richiesta…"
        pending={uninstall.isPending}
        onConfirm={() => uninstall.mutate({ id: node.id })}
      />
    </>
  );
}
