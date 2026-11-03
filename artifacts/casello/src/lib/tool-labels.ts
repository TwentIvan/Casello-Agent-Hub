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

export const TOOL_IDENTITY_LABELS: Record<ToolIdentity, string> = {
  user: "Utente",
  service: "Servizio",
};
