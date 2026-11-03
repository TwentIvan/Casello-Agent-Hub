import type { ToolIdentity, ToolLevel, ToolStatus } from "@workspace/api-client-react";

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  draft: "Bozza",
  active: "Attivo",
  disabled: "Disattivato",
};

export const TOOL_LEVEL_LABELS: Record<ToolLevel, string> = {
  L0: "L0 · lettura",
  L1: "L1 · azione",
  L2: "L2 · con conferma",
  L3: "L3 · vietata",
};

export const TOOL_LEVELS = ["L0", "L1", "L2", "L3"] as const;

/** Livelli ammessi come override di uno strumento: solo quelli uguali o più alti del dichiarato. */
export function overrideLevels(level: ToolLevel): ToolLevel[] {
  return TOOL_LEVELS.filter((l) => l > level);
}

export const TOOL_IDENTITY_LABELS: Record<ToolIdentity, string> = {
  user: "Utente",
  service: "Servizio",
};
