import { failPausedLocalRuns } from "../run-executor";
import { closeMachineJobs, MACHINE_UNAVAILABLE } from "./jobs";
import { revokeMachine } from "./machines";

/**
 * Revoca dalla console di una macchina dell'utente (persa o compromessa): la macchina e il suo modello spariscono, i
 * suoi lavori aperti falliscono con "macchina non disponibile" (i token di lavoro non valgono più) e le run in pausa
 * su quei lavori si chiudono come fallite. False se la macchina non esiste o è di un altro utente.
 */
export async function revokeLocalMachine(userId: number, machineId: number): Promise<boolean> {
  if (!(await revokeMachine(userId, machineId))) return false;
  const closed = await closeMachineJobs(machineId);
  const runIds = closed.flatMap((j) => (j.runId === null ? [] : [j.runId]));
  await failPausedLocalRuns(runIds, MACHINE_UNAVAILABLE);
  return true;
}
