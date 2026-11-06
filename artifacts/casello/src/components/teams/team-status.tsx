import type { TeamInstanceStatus } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";

export const TEAM_STATUS_LABELS: Record<TeamInstanceStatus, string> = {
  draft: "Bozza",
  active: "Attiva",
  closed: "Chiusa",
};

const LED: Record<TeamInstanceStatus, LedState> = {
  draft: "idle",
  active: "work",
  closed: "ok",
};

/** Stato di una squadra: bozza, attiva o chiusa (non si riapre). */
export function TeamStatusBadge({ status, className }: { status: TeamInstanceStatus; className?: string }) {
  return (
    <Led state={LED[status]} label={TEAM_STATUS_LABELS[status]} className={className} />
  );
}
