import type { ToolIdentity, ToolStatus } from "@workspace/api-client-react";

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  draft: "Bozza",
  active: "Attivo",
  disabled: "Disattivato",
};

export const TOOL_IDENTITY_LABELS: Record<ToolIdentity, string> = {
  user: "Utente",
  service: "Servizio",
};
