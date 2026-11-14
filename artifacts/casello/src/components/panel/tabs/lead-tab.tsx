// Scheda «Barbara» del pannello (solo console): chat con Barbara, la Responsabile di Botcave (agente `general` dell'App
// `casello`). Ogni messaggio porta la pagina corrente; se non è usabile si mostra il motivo.
import { getGetLeadChatQueryKey, useGetLeadChat } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Led } from "@/components/brand/led";
import { CharacterChat } from "@/components/characters/character-chat";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { leadPageFromPath } from "../page-subject";
import { PanelLink } from "../panel-link";

export function LeadTab() {
  const [location] = useLocation();
  const availability = useGetLeadChat({ query: { queryKey: getGetLeadChatQueryKey() } });

  if (availability.isError) {
    return <p className="p-4 text-body-sm text-danger">Impossibile leggere Barbara, la Responsabile di Botcave: {apiErrorMessage(availability.error)}</p>;
  }
  if (availability.isLoading || !availability.data) {
    return (
      <div className="p-4">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  const a = availability.data;
  if (!a.available) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
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
