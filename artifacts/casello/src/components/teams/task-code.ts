import type { TeamCodeTask } from "@workspace/api-client-react";

const CI_LABELS: Record<NonNullable<TeamCodeTask["ciState"]>, string> = {
  pending: "CI in corso",
  success: "CI verde",
  failure: "CI non superata",
  none: "Nessuna CI",
};

/** Testo della CI senza riepilogo: «CI non ancora letta» solo finché lo stato non c'è. */
export function ciLabel(code: Pick<TeamCodeTask, "prNumber" | "ciState">): string {
  if (code.prNumber === null) return "Nessuna PR";
  return code.ciState === null ? "CI non ancora letta" : CI_LABELS[code.ciState];
}
