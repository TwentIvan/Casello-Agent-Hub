import type { AppArchitecture, ArchitectureRefresh } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

/** LED della carta: in corso, errore, sintesi presente, altrimenti in attesa. */
export function architectureLed(a: Pick<AppArchitecture, "status" | "summary">): LedState {
  if (a.status === "running") return "work";
  if (a.status === "error") return "ko";
  return a.summary ? "ok" : "idle";
}

export const REFRESH_LABELS: Record<ArchitectureRefresh, string> = {
  off: "Spento",
  hourly: "Ogni ora",
  "6h": "Ogni 6 ore",
  daily: "Ogni giorno",
  weekly: "Ogni settimana",
};

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

const LCS_MAX_CELLS = 1_000_000;

/** Confronto riga per riga (sottosequenza comune più lunga). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // Oltre il tetto la tabella costerebbe troppo: confronto grezzo
  if (x.length * y.length > LCS_MAX_CELLS) {
    return [...x.map((text): DiffLine => ({ kind: "removed", text })), ...y.map((text): DiffLine => ({ kind: "added", text }))];
  }
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: "same", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: x[i++] });
    } else {
      out.push({ kind: "added", text: y[j++] });
    }
  }
  while (i < x.length) out.push({ kind: "removed", text: x[i++] });
  while (j < y.length) out.push({ kind: "added", text: y[j++] });
  return out;
}
