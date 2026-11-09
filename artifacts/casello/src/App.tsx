import { Switch, Route, Router as WouterRouter } from "wouter";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGate } from "@/components/auth-gate";
import { AppShell } from "@/components/layout/app-shell";
import { AlfredVoiceProvider } from "@/components/panel/voice-context";
import { PanelProvider, type PanelEnv } from "@/components/panel/panel-context";
import { ConsolePanelSheet } from "@/components/panel/console-panel-sheet";
import { isClientError } from "@/lib/api-errors";
import { isUnauthorized } from "@/lib/auth";
import Dashboard from "@/pages/dashboard";
import AppsPage from "@/pages/apps";
import AppDetailPage from "@/pages/app-detail";
import AppPlanPage from "@/pages/app-plan";
import AgentsPage from "@/pages/agents";
import AgentDetailPage from "@/pages/agent-detail";
import RunsPage from "@/pages/runs";
import PendingActionsPage from "@/pages/pending-actions";
import RunDetailPage from "@/pages/run-detail";
import AnalysisDetailPage from "@/pages/analysis-detail";
import AccountPage from "@/pages/account";
import AlfredPage from "@/pages/alfred";
import ModelsPage from "@/pages/models";
import SkillsPage from "@/pages/skills";
import SkillDetailPage from "@/pages/skill-detail";
import TeamTemplatesPage from "@/pages/team-templates";
import TeamTemplateDetailPage from "@/pages/team-template-detail";
import TeamsPage from "@/pages/teams";
import TeamDetailPage from "@/pages/team-detail";
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

// Ambiente stabile del pannello nella console: un oggetto nuovo a ogni render rinnoverebbe il contesto
const CONSOLE_PANEL_ENV: PanelEnv = { surface: "console" };

function Router() {
  // Dentro AuthGate: uscendo dalla sessione la voce di Alfred si smonta. Un solo pannello per tutta la console
  // (pulsanti «Chiedi a…» e passaggi di consegne tra Alfred e Lucius); PanelProvider legge l'indirizzo di wouter.
  return (
    <AlfredVoiceProvider>
      <PanelProvider env={CONSOLE_PANEL_ENV}>
        <AppShell>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/apps" component={AppsPage} />
            <Route path="/apps/:id" component={AppDetailPage} />
            <Route path="/apps/:id/plan" component={AppPlanPage} />
            <Route path="/agents" component={AgentsPage} />
            <Route path="/agents/:id" component={AgentDetailPage} />
            <Route path="/runs" component={RunsPage} />
            <Route path="/runs/:id" component={RunDetailPage} />
            <Route path="/pending-actions" component={PendingActionsPage} />
            <Route path="/models" component={ModelsPage} />
            <Route path="/skills" component={SkillsPage} />
            <Route path="/skills/:code" component={SkillDetailPage} />
            <Route path="/team-templates" component={TeamTemplatesPage} />
            <Route path="/team-templates/:id" component={TeamTemplateDetailPage} />
            <Route path="/teams" component={TeamsPage} />
            <Route path="/teams/:id" component={TeamDetailPage} />
            <Route path="/analyses/:id" component={AnalysisDetailPage} />
            <Route path="/account" component={AccountPage} />
            <Route path="/alfred" component={AlfredPage} />
            <Route component={NotFound} />
          </Switch>
        </AppShell>
        <ConsolePanelSheet />
      </PanelProvider>
    </AlfredVoiceProvider>
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
