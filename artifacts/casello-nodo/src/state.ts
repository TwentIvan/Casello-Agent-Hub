import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stato del nodo letto da `casello-nodo status`: niente segreti. */
export interface NodeState {
  pid: number;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  tasks: Array<{ taskId: number; startedAt: string }>;
  lastError: string | null;
}

/** Scrive lo stato in modo atomico (file temporaneo + rename), permessi 600. */
export async function writeState(statePath: string, state: NodeState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tmp = `${statePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, statePath);
}

export async function readState(statePath: string): Promise<NodeState | null> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as NodeState;
  } catch {
    return null;
  }
}
