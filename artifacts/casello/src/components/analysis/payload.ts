import type { AnalysisChapter, AnalysisItem, ItemDiff, ItemStatus } from "@workspace/api-client-react";

// Lettura difensiva dei payload della proposta: nel client sono `unknown`, e il modello può
// consegnare forme inattese. Ogni lettore restituisce un valore del tipo atteso o `undefined`.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const str = (obj: unknown, key: string): string | undefined => {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
};

export const num = (obj: unknown, key: string): number | undefined => {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const bool = (obj: unknown, key: string): boolean | undefined => {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
};

export const strList = (obj: unknown, key: string): string[] => {
  if (!isRecord(obj)) return [];
  const value = obj[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
};

export const rec = (obj: unknown, key: string): Rec | undefined => {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return isRecord(value) ? value : undefined;
};

export const list = (obj: unknown, key: string): unknown[] => {
  if (!isRecord(obj)) return [];
  const value = obj[key];
  return Array.isArray(value) ? value : [];
};

/** JSON indentato per i `<pre>`; non lancia mai. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// --- Etichette ---

/** Ordine delle schede in revisione. */
export const CHAPTERS: AnalysisChapter[] = ["tool", "agent", "skill", "endpoint", "completion", "evolution"];

export const CHAPTER_LABELS: Record<AnalysisChapter, string> = {
  tool: "Tool",
  agent: "Agenti",
  skill: "Skill",
  endpoint: "Endpoint",
  completion: "Completamento",
  evolution: "Evoluzione",
};

/** Capitoli che si possono rimandare (e che si esportano come issue). */
export const POSTPONABLE = new Set<AnalysisChapter>(["endpoint", "completion", "evolution"]);
/** Tutti i capitoli si esportano: issue per i tre rimandabili, documentazione per tool, agenti e skill. */
export type ExportableChapter = AnalysisChapter;
export const isExportable = (_chapter: AnalysisChapter): _chapter is ExportableChapter => true;

export const DIFF_LABELS: Record<ItemDiff, string> = {
  new: "Nuovo",
  changed: "Modificato",
  removed: "Rimosso",
  unchanged: "Invariato",
};

export const DIFF_STYLES: Record<ItemDiff, string> = {
  new: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  changed: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  removed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  unchanged: "bg-muted text-muted-foreground",
};

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  pending: "In attesa",
  approved: "Approvato",
  discarded: "Scartato",
  postponed: "Rimandato",
};

export const ITEM_STATUS_STYLES: Record<ItemStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  discarded: "bg-muted text-muted-foreground",
  postponed: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
};

export const PHASE_LABELS: Record<string, string> = {
  sorgenti: "Sorgenti",
  map: "Mappa",
  capabilities: "Capacità",
  catalog: "Catalogo",
  agents: "Agenti e skill",
  completion: "Completamento",
  evolution: "Evoluzione",
};

export const phaseLabel = (phase: string | null | undefined): string =>
  phase ? (PHASE_LABELS[phase] ?? phase) : "—";

// --- Titolo e area di un elemento ---

/** Titolo leggibile dell'elemento, con ripiego sul riferimento stabile. */
export function itemTitle(item: AnalysisItem): string {
  const p = item.payload;
  switch (item.chapter) {
    case "tool":
    case "agent":
    case "skill":
      return str(p, "name") || item.ref;
    case "endpoint":
    case "completion":
    case "evolution":
      return str(p, "title") || item.ref;
    default:
      return item.ref;
  }
}

/** Area dell'elemento, se il payload la indica. */
export function itemArea(item: AnalysisItem): string | undefined {
  const p = item.payload;
  if (item.chapter === "agent") {
    return str(p, "role") === "general" ? "Agente generale" : str(p, "area");
  }
  if (item.chapter === "skill") {
    return str(p, "agentRole") === "general" ? "Agente generale" : str(p, "agentArea");
  }
  return str(p, "area");
}

// --- Completamento ---

export interface CompletionInfo {
  key: string;
  phase: number | undefined;
  dependsOn: string[];
  title: string;
}

export function completionInfo(item: AnalysisItem): CompletionInfo {
  return {
    key: str(item.payload, "key") ?? item.ref,
    phase: num(item.payload, "phase"),
    dependsOn: strList(item.payload, "dependsOn"),
    title: itemTitle(item),
  };
}

/**
 * Ordine delle dipendenze (prima le voci da cui altre dipendono), stabile rispetto all'ordine
 * ricevuto (posizione). Un ciclo o una chiave ignota non bloccano: la visita si interrompe e
 * resta l'ordine di posizione.
 */
export function dependencyOrder(items: AnalysisItem[]): AnalysisItem[] {
  const byKey = new Map(items.map((i) => [completionInfo(i).key, i]));
  const done = new Set<AnalysisItem>();
  const visiting = new Set<AnalysisItem>();
  const out: AnalysisItem[] = [];
  const visit = (item: AnalysisItem) => {
    if (done.has(item) || visiting.has(item)) return;
    visiting.add(item);
    for (const dep of completionInfo(item).dependsOn) {
      const target = byKey.get(dep);
      if (target) visit(target);
    }
    visiting.delete(item);
    done.add(item);
    out.push(item);
  };
  items.forEach(visit);
  return out;
}
