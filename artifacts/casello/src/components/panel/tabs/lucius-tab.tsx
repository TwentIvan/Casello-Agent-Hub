// Scheda «Lucius» del pannello. Nella console: l'argomento dichiarato dalla pagina (usePanelSubject); nell'iframe: la chat
// del piano dell'App di Botcave con lo slug della pagina ospite (`data-app`). Un passaggio di consegne verso un altro
// argomento lo sostituisce finché non si cambia pagina, con «Torna a…» in cima.
import { getListAppsQueryKey, useListApps } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { LuciusMark } from "@/components/brand/marks";
import type { ChatTarget } from "@/components/characters/adapters";
import { CharacterChat } from "@/components/characters/character-chat";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { findAppBySlug } from "@/embed/panel-helpers";
import { targetLabel } from "../page-subject";
import { usePanel } from "../panel-context";
import { PanelLink } from "../panel-link";

/** Chat di Lucius sull'argomento, con la bozza di un passaggio di consegne (rimontata a ogni passaggio nuovo). */
function LuciusChat({ target }: { target: ChatTarget }) {
  const { state, hasUnsavedChanges } = usePanel();
  const draft = state.draft?.tab === "lucius" ? state.draft.text : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CharacterChat key={state.nonce} target={target} draft={draft} hasUnsavedChanges={hasUnsavedChanges} layout="sheet" />
    </div>
  );
}

/** Embed: chat del piano dell'App con lo slug della pagina ospite, o l'avviso che non è registrata. */
function EmbedAppPlan({ appSlug, appName }: { appSlug: string; appName: string | null }) {
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey() } });

  if (apps.isError) {
    return <p className="p-4 text-body-sm text-danger">Impossibile caricare le app: {apiErrorMessage(apps.error)}</p>;
  }
  if (apps.isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  const app = findAppBySlug(apps.data, appSlug);
  if (!app) {
    const name = appName ?? (appSlug || "Questa app");
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <LuciusMark size={24} />
        <Led state="idle" label={`${name} non è ancora registrata in Botcave`} />
        <Button asChild variant="secondary">
          <PanelLink path="/apps">Apri Botcave</PanelLink>
        </Button>
      </div>
    );
  }
  return <LuciusChat target={{ kind: "plan", appId: app.id }} />;
}

/** Console su una pagina senza argomento di Lucius. */
function NoSubject() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <LuciusMark size={24} />
      <Led state="idle" label="Lucius lavora su app, agenti, skill, modelli di squadra e squadre: apri una di queste pagine" />
    </div>
  );
}

export function LuciusTab() {
  const { state, env, clearOverride } = usePanel();

  if (state.override) {
    const back = state.pageLucius ? `Torna a ${targetLabel(state.pageLucius)}` : "Torna indietro";
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-w-0 border-b border-border px-3 py-1">
          <Button variant="link" size="sm" className="h-auto max-w-full px-0" onClick={clearOverride}>
            <span className="truncate">{back}</span>
          </Button>
        </div>
        <LuciusChat target={state.override} />
      </div>
    );
  }
  if (env.surface === "embed") return <EmbedAppPlan appSlug={env.appSlug} appName={env.appName} />;
  if (state.pageLucius) return <LuciusChat target={state.pageLucius} />;
  return <NoSubject />;
}
