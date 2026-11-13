import type { TeamReadiness, TeamReadinessRole } from "@workspace/api-client-react";

/** LED di un ruolo: rosso con un errore, giallo con soli avvisi, verde senza problemi. */
export function roleLed(role: TeamReadinessRole): "ok" | "ask" | "ko" {
  if (role.problems.some((p) => p.level === "error")) return "ko";
  return role.problems.length > 0 ? "ask" : "ok";
}

/** Problemi che impediscono ai ruoli di lavorare (solo `error`), nell'ordine dei ruoli. */
export function blockingProblems(readiness: TeamReadiness): { roleName: string; message: string }[] {
  return readiness.roles.flatMap((role) =>
    role.problems.filter((p) => p.level === "error").map((p) => ({ roleName: role.roleName, message: p.message })),
  );
}

export function activateLabel(readiness: TeamReadiness | undefined): "Attiva" | "Attiva comunque" {
  return readiness && blockingProblems(readiness).length > 0 ? "Attiva comunque" : "Attiva";
}
