import { Link, useParams } from "wouter";
import { usePanelSubject } from "@/components/panel/panel-context";
import { ArrowLeft } from "lucide-react";
import { ApiError, getGetAppQueryKey, useGetApp } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { LuciusMark } from "@/components/brand/marks";
import { Skeleton } from "@/components/ui/skeleton";
import { CharacterChat } from "@/components/characters/character-chat";
import { PlanList } from "@/components/plan/plan-list";
import { apiErrorMessage } from "@/lib/api-errors";

export default function AppPlanPage() {
  const params = useParams<{ id: string }>();
  const appId = Number(params.id);
  const validId = Number.isInteger(appId) && appId > 0;
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId), enabled: validId } });

  usePanelSubject({ lucius: app.data ? { kind: "plan", appId } : null });

  const notFound = !validId || (app.error instanceof ApiError && app.error.status === 404);

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href={validId ? `/apps/${appId}` : "/apps"}>
          <ArrowLeft />
          {app.data ? app.data.name : "Tutte le app"}
        </Link>
      </Button>
      {notFound ? (
        <p className="text-sm text-muted-foreground">App non trovata.</p>
      ) : app.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare l'app: {apiErrorMessage(app.error)}</p>
      ) : !app.data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <div className="flex items-center gap-4">
            <LuciusMark size={30} />
            <div className="min-w-0 space-y-1">
              <h2 className="text-h2">Piano e chat · {app.data.name}</h2>
              <p className="text-sm text-muted-foreground">
                Il piano dell'app e una chat con Lucius per integrarlo: le sue proposte diventano voci solo quando le accetti.
              </p>
            </div>
          </div>
          <div className="grid gap-8 lg:grid-cols-2">
            <section aria-label="Piano" className="min-w-0">
              <PlanList appId={appId} />
            </section>
            <section aria-label="Conversazioni" className="min-w-0">
              <CharacterChat target={{ kind: "plan", appId }} layout="page" />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
