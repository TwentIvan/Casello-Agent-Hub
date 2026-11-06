import type { AgentStatus, AppStatus } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";

export const APP_STATUS_LABELS: Record<AppStatus, string> = {
  active: "Attiva",
  inactive: "Inattiva",
};

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  active: "Attivo",
  inactive: "Inattivo",
  draft: "Bozza",
};

const LED: Record<AgentStatus, LedState> = {
  active: "ok",
  inactive: "idle",
  draft: "idle",
};

type StatusBadgeProps =
  | { kind: "app"; status: AppStatus; className?: string }
  | { kind: "agent"; status: AgentStatus; className?: string };

/** Stato di App (attiva / inattiva) e Agenti (attivo / inattivo / bozza). */
export function StatusBadge({ kind, status, className }: StatusBadgeProps) {
  const label = kind === "app" ? APP_STATUS_LABELS[status as AppStatus] : AGENT_STATUS_LABELS[status];
  return (
    <Led state={LED[status]} label={label} className={className} />
  );
}
