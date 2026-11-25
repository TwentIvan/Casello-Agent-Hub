import { MessageSquare } from "lucide-react";
import type { TeamInstance } from "@workspace/api-client-react";
import { Led, LedDot } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TEAM_TABS, TEAM_TAB_LABELS, type TeamTab, currentWork, pollingLabel } from "@/lib/team-status-bar";
import { TEAM_POLL_MS, type TeamWorkState } from "./team-activity";
import { TeamStatusBadge } from "./team-status";

/**
 * Barra fissa in cima alla pagina squadra (resta visibile scorrendo): stato della squadra, turno o compito in corso,
 * indicatore dell'aggiornamento automatico, «Scrivi al capo» e, sotto, le schede. Va messa dentro `<Tabs>`.
 */
export function TeamStatusBar({
  team,
  work,
  taskTitles,
  dirty,
  onWriteToLead,
}: {
  team: TeamInstance;
  work: TeamWorkState;
  taskTitles: ReadonlyMap<string, string>;
  /** Modifiche non salvate nelle impostazioni: un LED sulla scheda lo ricorda. */
  dirty: boolean;
  onWriteToLead: () => void;
}) {
  const now = currentWork(work.turns.data, work.tasks.data, taskTitles);
  const polling = pollingLabel(team.status, work.polling, TEAM_POLL_MS);
  return (
    <div className="sticky top-0 z-20 space-y-2 border-b border-border bg-background py-2" data-testid="team-status-bar">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <TeamStatusBadge status={team.status} />
        <Led state={now.led} label={now.text} className="min-w-0 max-w-full" title={now.text} />
        <Led state={polling.led} label={polling.text} />
        {team.status === "active" && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={onWriteToLead}>
            <MessageSquare />
            Scrivi al capo
          </Button>
        )}
      </div>
      <TabsList className="h-auto flex-wrap justify-start">
        {TEAM_TABS.map((tab: TeamTab) => (
          <TabsTrigger key={tab} value={tab} className="gap-1.5">
            {TEAM_TAB_LABELS[tab]}
            {tab === "settings" && dirty && <LedDot state="ask" className="ml-0.5" />}
            {tab === "settings" && dirty && <span className="sr-only">(modifiche non salvate)</span>}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
