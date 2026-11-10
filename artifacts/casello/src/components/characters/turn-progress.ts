import type { TurnProgress } from "@workspace/api-client-react";

export type ProgressLineState = "work" | "done" | "muted";
export interface ProgressLine {
  text: string;
  state: ProgressLineState;
}

/** «42 s» sotto il minuto, poi «1 min 05 s»; un valore negativo vale 0. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, "0");
  return `${min} min ${sec} s`;
}

/** Righe da mostrare mentre un personaggio lavora al turno; `nowMs` è passato da fuori per poterla provare. */
export function progressLines(
  p: TurnProgress | null,
  name: string,
  nowMs: number,
): { lines: ProgressLine[]; elapsed: string } {
  if (!p) return { lines: [{ text: `${name} sta pensando…`, state: "work" }], elapsed: "" };
  const lines: ProgressLine[] = [];
  if (p.omitted > 0) {
    lines.push({ text: p.omitted === 1 ? "… e un altro passo" : `… e altri ${p.omitted} passi`, state: "muted" });
  }
  for (const s of p.steps) lines.push({ text: s.text, state: s.status === "running" ? "work" : "done" });
  if (p.steps.length === 0) lines.push({ text: `${name} sta pensando…`, state: "work" });
  else if (!p.steps.some((s) => s.status === "running")) lines.push({ text: `${name} ragiona…`, state: "work" });
  return { lines, elapsed: formatElapsed(nowMs - Date.parse(p.startedAt)) };
}
