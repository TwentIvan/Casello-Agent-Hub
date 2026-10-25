import type { Agent } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

/** Etichetta del ruolo: «Generale» oppure l'area dell'agente (se impostata). */
export function agentRoleLabel(agent: Pick<Agent, "role" | "area">): string {
  if (agent.role === "general") return "Generale";
  return agent.area?.trim() || "Area";
}

export function AgentRoleBadge({ agent }: { agent: Pick<Agent, "role" | "area"> }) {
  return (
    <Badge variant={agent.role === "general" ? "default" : "outline"} className="font-normal">
      {agentRoleLabel(agent)}
    </Badge>
  );
}
