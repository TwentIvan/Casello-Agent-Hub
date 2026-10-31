import type { AnalysisItem } from "@workspace/db";
import { completionData, issueMarkdown, topoSort } from "../architect/issues";

// Contenuto delle issue GitHub create dal piano: eligibilità, ordine, etichette, titolo e corpo (puro).

const CHAPTER_LABELS: Record<string, string> = {
  endpoint: "endpoint",
  completion: "completamento",
  evolution: "evoluzione",
};

/** Solo le voci approvate di endpoint, completamento ed evoluzione diventano issue. */
export function isEligible(item: AnalysisItem): boolean {
  return item.status === "approved" && item.chapter in CHAPTER_LABELS;
}

/** Completamento per fase e in ordine di dipendenza (come `exportIssues`), poi le altre nell'ordine ricevuto. */
export function creationOrder(items: AnalysisItem[]): AnalysisItem[] {
  const completion = items.filter((i) => i.chapter === "completion");
  const phases = [...new Set(completion.map((i) => completionData(i).phase))].sort((a, b) => a - b);
  const ordered = phases.flatMap((phase) =>
    topoSort(
      completion.filter((i) => completionData(i).phase === phase),
      (i) => completionData(i).key,
      (i) => completionData(i).dependsOn,
    ),
  );
  return [...ordered, ...items.filter((i) => i.chapter !== "completion")];
}

export function issueLabels(item: AnalysisItem): string[] {
  const labels = ["casello"];
  const chapter = CHAPTER_LABELS[item.chapter];
  if (chapter) labels.push(chapter);
  const payload = (item.payload ?? {}) as { phase?: unknown; priority?: unknown };
  if (item.chapter === "completion" && typeof payload.phase === "number") labels.push(`fase-${payload.phase}`);
  if (
    item.chapter === "evolution" &&
    typeof payload.priority === "number" &&
    Number.isInteger(payload.priority) &&
    payload.priority >= 1 &&
    payload.priority <= 5
  ) {
    labels.push(`P${payload.priority}`);
  }
  return labels;
}

export function issueContent(
  item: AnalysisItem,
  ctx: { appName: string; issueByKey: Map<string, number>; titleByKey: Map<string, string> },
): { title: string; body: string; labels: string[] } {
  const depTitles =
    item.chapter === "completion"
      ? completionData(item).dependsOn.map((key) => {
          const n = ctx.issueByKey.get(key);
          return n !== undefined ? `#${n}` : (ctx.titleByKey.get(key) ?? key);
        })
      : [];
  const { title, body } = issueMarkdown(item, depTitles);
  return {
    title,
    // Il nome dell'app su una riga: niente a capo che spezzino il piè di pagina
    body: `${body}\n\n---\nCreata da Casello · piano di ${ctx.appName.replace(/\s+/g, " ").trim()} · voce #${item.id}`,
    labels: issueLabels(item),
  };
}
