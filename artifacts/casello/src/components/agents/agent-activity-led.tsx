import type { AgentActivity } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { agentActivityView } from "@/lib/live-updates";

/** Stato in tempo reale di un agente (in lavoro, aspetta te, fermo), con il dettaglio nel tooltip. */
export function AgentActivityLed({ activity, className }: { activity: AgentActivity | undefined; className?: string }) {
  const view = agentActivityView(activity);
  return <Led state={view.led} label={view.label} title={view.detail} className={className} />;
}
