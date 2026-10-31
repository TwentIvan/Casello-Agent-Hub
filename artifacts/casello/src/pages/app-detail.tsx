import { Link, useParams } from "wouter";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { ApiError, getGetAppQueryKey, useGetApp } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentModelsCard } from "@/components/apps/agent-models-card";
import { AnalysesCard } from "@/components/apps/analyses-card";
import { AppSourcesCard } from "@/components/apps/app-sources-card";
import { ToolCatalog } from "@/components/apps/tool-catalog";
import { StatusBadge } from "@/components/status-badge";
import { apiErrorMessage } from "@/lib/api-errors";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm">{value}</dd>
    </div>
  );
}

export default function AppDetailPage() {
  const params = useParams<{ id: string }>();
  const appId = Number(params.id);
  const validId = Number.isInteger(appId) && appId > 0;
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId), enabled: validId } });

  const notFound = !validId || (app.error instanceof ApiError && app.error.status === 404);

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/apps">
          <ArrowLeft />
          Tutte le app
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
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">{app.data.name}</h2>
              <StatusBadge kind="app" status={app.data.status} />
              <Button variant="outline" size="sm" asChild className="ml-auto">
                <Link href={`/apps/${appId}/plan`}>
                  <MessagesSquare />
                  Piano e chat
                </Link>
              </Button>
            </div>
            {app.data.description && <p className="text-sm text-muted-foreground">{app.data.description}</p>}
            <dl className="grid gap-3 sm:grid-cols-3">
              <Field label="Slug" value={app.data.slug} />
              <Field label="Base URL" value={app.data.baseUrl} />
              <Field label="Indirizzo interno" value={app.data.internalBaseUrl || "—"} />
            </dl>
          </div>
          <ToolCatalog appId={appId} />
          <AgentModelsCard appId={appId} />
          <AppSourcesCard app={app.data} />
          <AnalysesCard app={app.data} />
        </>
      )}
    </div>
  );
}
