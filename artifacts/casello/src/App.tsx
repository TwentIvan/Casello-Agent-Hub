import { Switch, Route, Router as WouterRouter } from "wouter";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/auth-gate";
import { AppShell } from "@/components/layout/app-shell";
import { isClientError } from "@/lib/api-errors";
import { isUnauthorized } from "@/lib/auth";
import Dashboard from "@/pages/dashboard";
import AppsPage from "@/pages/apps";
import AgentsPage from "@/pages/agents";
import AgentDetailPage from "@/pages/agent-detail";
import ComingSoon from "@/pages/coming-soon";
import NotFound from "@/pages/not-found";

const currentUserKey = getGetCurrentUserQueryKey();

// Un 401 su qualunque chiamata vuol dire sessione scaduta: si ricontrolla l'utente e AuthGate
// mostra la pagina di login. Il 401 della query utente stessa va escluso, o si ricarica all'infinito.
function onApiError(error: unknown, queryKey?: readonly unknown[]) {
  const isCurrentUserQuery =
    queryKey?.length === currentUserKey.length && queryKey.every((part, i) => part === currentUserKey[i]);
  if (isUnauthorized(error) && !isCurrentUserQuery) {
    void queryClient.invalidateQueries({ queryKey: currentUserKey });
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => onApiError(error, query.queryKey) }),
  mutationCache: new MutationCache({ onError: (error) => onApiError(error) }),
  defaultOptions: {
    queries: { retry: (failureCount, error) => !isClientError(error) && failureCount < 3 },
  },
});

function Router() {
  return (
    <AppShell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/apps" component={AppsPage} />
        <Route path="/agents" component={AgentsPage} />
        <Route path="/agents/:id" component={AgentDetailPage} />
        <Route path="/runs">{() => <ComingSoon title="Run" />}</Route>
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate>
            <Router />
          </AuthGate>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
