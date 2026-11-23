import type { AnalysisChapter, AnalysisItem, TeamInstance } from "@workspace/api-client-react";

/** Capitoli del piano che una squadra può implementare. */
export const IMPLEMENT_CHAPTERS: AnalysisChapter[] = ["endpoint", "completion", "evolution"];

/** Limite del messaggio al capo (`POST /team-instances/:id/messages`). */
export const MAX_LEAD_MESSAGE = 4_000;

/** Tipo del lavoro di riferimento delle squadre create dal piano. */
export const PLAN_REF_TYPE = "piano";

/** Voce del piano da indicare al capo: id (lo stesso di `leggi_piano_app`), titolo e issue. */
export interface ImplementItem {
  id: number;
  title: string;
  issueNumber: number | null;
}

/**
 * Voci del piano che si possono implementare: approvate, nei capitoli endpoint, completamento ed evoluzione, senza
 * quelle con l'issue già chiusa (lavoro fatto o scartato su GitHub).
 */
export function implementableItems(items: AnalysisItem[]): AnalysisItem[] {
  return items.filter((i) => i.status === "approved" && IMPLEMENT_CHAPTERS.includes(i.chapter) && i.issue?.state !== "closed");
}

/**
 * Voci da elencare nel messaggio al capo: con tutte le voci scelte nessun elenco (il capo lavora su tutto il piano
 * approvato con `leggi_piano_app`), altrimenti quelle scelte.
 */
export function messageItems<T>(chosen: T[], total: number): T[] {
  return chosen.length === total ? [] : chosen;
}

/** Squadre che possono ricevere il piano: quelle dell'App non chiuse, prima le attive. */
export function implementTeams(teams: TeamInstance[], appId: number): TeamInstance[] {
  const order = { active: 0, draft: 1, closed: 2 } as const;
  return teams
    .filter((t) => t.ref.appId === appId && t.status !== "closed")
    .sort((a, b) => order[a.status] - order[b.status] || b.id - a.id);
}

/** Riferimento della squadra nuova creata dal piano dell'App. */
export function planTeamRef(appId: number, appName: string) {
  return { appId, type: PLAN_REF_TYPE, id: String(appId), title: `Piano di ${appName}`.slice(0, 300) };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Messaggio al capo: implementare il piano dell'App leggendolo con `leggi_piano_app`. Senza voci scelte vale tutto
 * il piano approvato; con le voci, l'elenco con id e issue (i titoli si accorciano e, oltre il limite, le voci in più
 * si contano soltanto: il capo le ritrova per id).
 */
export function implementMessage(appName: string, items: ImplementItem[]): string {
  const head = `Implementa il piano di sviluppo dell'App «${oneLine(appName)}».`;
  const how =
    "Questo è un lavoro nuovo, anche se il lavoro precedente della squadra è finito o chiuso: non chiamare `chiudi_lavoro`. Leggi le voci approvate con `leggi_piano_app` e proponi subito con `proponi_piano` un PLAN nuovo (obiettivo nuovo, un compito per voce con il campo `issue` quando la voce ne ha una; i compiti già finiti del PLAN precedente puoi toglierli); quando è approvato, assegna i compiti nell'ordine delle dipendenze.";
  if (items.length === 0) return `${head} Lavora su tutte le voci approvate del piano.\n${how}`;
  const intro = `${head} Lavora solo su ${items.length === 1 ? "questa voce" : `queste ${items.length} voci`} (id di \`leggi_piano_app\`):`;
  const lines = items.map((i) => {
    const title = oneLine(i.title);
    const short = title.length > 120 ? `${title.slice(0, 119)}…` : title;
    return `- #${i.id} ${short}${i.issueNumber !== null ? ` (issue #${i.issueNumber})` : ""}`;
  });
  // Spazio per la riga «- e altre N voci» se le voci non ci stanno tutte
  const budget = MAX_LEAD_MESSAGE - intro.length - how.length - 2 - 30;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length) kept.push(`- e altre ${lines.length - kept.length} voci`);
  return `${intro}\n${kept.join("\n")}\n${how}`;
}
