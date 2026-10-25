import type { Run, RunStatus } from "@workspace/api-client-react";

export const ACTIVE_RUN_STATUSES: RunStatus[] = ["pending", "running", "awaiting_client"];

export function isRunActive(run: Pick<Run, "status">): boolean {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}

/** Ogni quanto ricaricare una lista di run: solo finché ce n'è almeno una in corso. */
export function listRefetchInterval(runs: Run[] | undefined, ms = 3000): number | false {
  return runs?.some(isRunActive) ? ms : false;
}
