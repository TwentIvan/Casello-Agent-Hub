// Scheda «Lucius» del pannello: la chat del piano dell'App di Botcave con lo slug della pagina ospite (`data-app`).
import { getListAppsQueryKey, useListApps } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { LuciusMark } from "@/components/brand/marks";
import { CharacterChat } from "@/components/characters/character-chat";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { consoleUrl, findAppBySlug } from "../panel-helpers";

export function LuciusTab({ appSlug, appName }: { appSlug: string; appName: string | null }) {
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
          <a href={consoleUrl(window.location.origin, "/apps")} target="_blank" rel="noopener">
            Apri Botcave
          </a>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CharacterChat target={{ kind: "plan", appId: app.id }} layout="sheet" />
    </div>
  );
}
