// Scheda del Responsabile di prodotto. Nella console: Barbara, la Responsabile di Botcave (agente `general` dell'App
// `casello`), con la pagina della console. Nell'iframe: il Responsabile dell'App ospite, con la pagina dell'app ospite e
// le azioni della barra «Stai guardando». Se non è usabile si mostra il motivo.
import { useEffect, useRef } from "react";
import { getGetLeadChatQueryKey, useGetLeadChat } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Led } from "@/components/brand/led";
import { BarbaraMark } from "@/components/brand/marks";
import { CharacterChat } from "@/components/characters/character-chat";
import { useLeadChatAdapter } from "@/components/characters/lead-adapter";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { leadHostPage } from "@/embed/panel-helpers";
import type { HostContextMsg } from "@/embed/protocol";
import { leadPageFromPath } from "../page-subject";
import { usePanel } from "../panel-context";
import { PanelLink } from "../panel-link";

function Loading() {
  return (
    <div className="p-4">
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function ConsoleLeadTab() {
  const [location] = useLocation();
  const availability = useGetLeadChat(undefined, { query: { queryKey: getGetLeadChatQueryKey() } });

  if (availability.isError) {
    return <p className="p-4 text-body-sm text-danger">Impossibile leggere Barbara, la Responsabile di Botcave: {apiErrorMessage(availability.error)}</p>;
  }
  if (availability.isLoading || !availability.data) return <Loading />;
  const a = availability.data;
  if (!a.available) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <BarbaraMark size={24} />
        <Led state="idle" label={a.reason ?? "Barbara non è disponibile"} />
        {a.agentId != null && (
          <Button asChild variant="secondary">
            <PanelLink path={`/agents/${a.agentId}`}>Apri l'agente di Barbara</PanelLink>
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CharacterChat target={{ kind: "lead", page: leadPageFromPath(location) }} layout="sheet" />
    </div>
  );
}

/** Embed: il Responsabile dell'App ospite; manda anche le azioni scelte nella barra del contesto. */
function EmbedLeadTab({ appSlug, hostContext, fallbackName }: { appSlug: string; hostContext: HostContextMsg | null; fallbackName: string }) {
  const { state, actionDone } = usePanel();
  const { toast } = useToast();
  const params = appSlug ? { app: appSlug } : undefined;
  const availability = useGetLeadChat(params, { query: { queryKey: getGetLeadChatQueryKey(params) } });
  const a = availability.data;
  const leadName = a?.leadName ?? fallbackName;
  const page = leadHostPage(appSlug, hostContext);
  const adapter = useLeadChatAdapter(page, { app: appSlug || undefined, leadName });

  // Azione della barra: presa in carico una volta per numero (anche con gli effetti ripetuti di StrictMode)
  const handled = useRef<number | null>(null);
  const pending = state.action;
  const available = a?.available === true;
  const ready = a !== undefined;
  useEffect(() => {
    if (!pending) {
      handled.current = null;
      return;
    }
    if (!ready || handled.current === pending.seq) return;
    handled.current = pending.seq;
    actionDone(pending.seq);
    // Responsabile non disponibile: la scheda mostra già il motivo
    if (!available) return;
    adapter
      .sendAction(pending.label)
      .then((result) => {
        if (result === "busy") toast({ title: `${leadName} sta già rispondendo` });
      })
      .catch((error: unknown) => toast({ variant: "destructive", title: "Azione non mandata", description: apiErrorMessage(error) }));
  }, [pending, ready, available, adapter, actionDone, toast, leadName]);

  if (availability.isError) {
    return <p className="p-4 text-body-sm text-danger">Impossibile leggere il Responsabile di questa app: {apiErrorMessage(availability.error)}</p>;
  }
  if (availability.isLoading || !a) return <Loading />;
  if (!a.available) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <BarbaraMark size={24} />
        <Led state="idle" label={a.reason ?? `${leadName} non è disponibile`} />
        <Button asChild variant="secondary">
          <PanelLink path={a.agentId != null ? `/agents/${a.agentId}` : "/apps"}>Apri Botcave</PanelLink>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CharacterChat target={{ kind: "lead", page, app: appSlug || undefined, leadName }} layout="sheet" />
    </div>
  );
}

export function LeadTab() {
  const { env } = usePanel();
  if (env.surface === "console") return <ConsoleLeadTab />;
  return <EmbedLeadTab appSlug={env.appSlug} hostContext={env.hostContext} fallbackName={env.botNames?.lead ?? "Responsabile"} />;
}
