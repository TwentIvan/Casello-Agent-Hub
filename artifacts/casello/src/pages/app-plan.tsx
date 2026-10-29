import { useState } from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft } from "lucide-react";
import { ApiError, getGetAppQueryKey, useGetApp } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatPanel } from "@/components/plan/chat-panel";
import { ConversationList } from "@/components/plan/conversation-list";
import { PlanList } from "@/components/plan/plan-list";
import { apiErrorMessage } from "@/lib/api-errors";

export default function AppPlanPage() {
  const params = useParams<{ id: string }>();
  const appId = Number(params.id);
  const validId = Number.isInteger(appId) && appId > 0;
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId), enabled: validId } });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const notFound = !validId || (app.error instanceof ApiError && app.error.status === 404);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
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
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">Piano e chat · {app.data.name}</h2>
            <p className="text-sm text-muted-foreground">
              Il piano dell'app e una chat per integrarlo: le proposte del bot diventano voci solo quando le accetti.
            </p>
          </div>
          <div className="grid gap-8 lg:grid-cols-2">
            <section aria-label="Piano" className="min-w-0">
              <PlanList appId={appId} />
            </section>
            <section aria-label="Conversazioni" className="min-w-0 space-y-6">
              <ConversationList appId={appId} selectedId={selectedId} onSelect={setSelectedId} />
              {selectedId !== null && (
                <ChatPanel key={selectedId} conversationId={selectedId} appId={appId} onDeleted={() => setSelectedId(null)} />
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
