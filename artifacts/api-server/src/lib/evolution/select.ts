import type { AnalysisItem } from "@workspace/db";
import { completionData } from "../architect/issues";
import { creationOrder } from "../plan-issues/content";

function priorityOf(item: AnalysisItem): number {
  const p = (item.payload as { priority?: unknown } | null)?.priority;
  return typeof p === "number" ? p : Number.MAX_SAFE_INTEGER;
}

/**
 * Voci da approvare in un giro: prima il completamento in ordine di dipendenza (una voce con una
 * dipendenza candidata non ancora scelta si salta), poi l'evoluzione per priorità. Al più `n` id.
 */
export function selectRoundItems(items: AnalysisItem[], n: number): number[] {
  const pending = items.filter((i) => i.status === "pending");
  const completion = creationOrder(pending.filter((i) => i.chapter === "completion"));
  const evolution = pending
    .filter((i) => i.chapter === "evolution")
    .sort((a, b) => priorityOf(a) - priorityOf(b) || a.position - b.position);

  const candidateKeys = new Map<string, number>();
  for (const c of completion) candidateKeys.set(completionData(c).key, c.id);
  const chosen = new Set<number>();
  const result: number[] = [];

  for (const item of completion) {
    if (result.length >= n) break;
    const blocked = completionData(item).dependsOn.some((d) => {
      const depId = candidateKeys.get(d);
      return depId !== undefined && depId !== item.id && !chosen.has(depId);
    });
    if (blocked) continue;
    chosen.add(item.id);
    result.push(item.id);
  }
  for (const item of evolution) {
    if (result.length >= n) break;
    result.push(item.id);
  }
  return result;
}
