import type { RunActivity } from "@workspace/api-client-react";
import { formatElapsed } from "../components/characters/turn-progress";

export interface RunActivityLine {
  text: string;
  elapsed: string;
}

/**
 * Righe dell'attività in corso di una run (issue #118): una per chiamata al modello o tool in esecuzione, con il tempo
 * trascorso; nessuna attività in corso (tra un passo e l'altro) → «L'agente sta lavorando…». `nowMs` è passato da
 * fuori per poterla provare.
 */
export function runActivityLines(activity: RunActivity | null | undefined, nowMs: number): RunActivityLine[] {
  if (!activity || activity.items.length === 0) {
    return [{ text: "L'agente sta lavorando…", elapsed: activity ? formatElapsed(nowMs - Date.parse(activity.startedAt)) : "" }];
  }
  return activity.items.map((item) => ({
    text: item.kind === "model" ? "Pensa" : `Usa ${item.toolName ?? "uno strumento"}`,
    elapsed: formatElapsed(nowMs - Date.parse(item.since)),
  }));
}
