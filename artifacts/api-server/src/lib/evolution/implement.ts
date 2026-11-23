// Messaggio «Implementa» al capo della squadra del ciclo (puro): stesso testo di `implementMessage` della console
// (`artifacts/casello/src/lib/implement-plan.ts`), con le voci del giro (id di `leggi_piano_app`, titolo, issue).

/** Limite del messaggio al capo (`POST /team-instances/:id/messages`). */
export const MAX_LEAD_MESSAGE = 4_000;

export interface ImplementItem {
  id: number;
  title: string;
  issueNumber: number | null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Messaggio al capo: implementare le voci del giro leggendole con `leggi_piano_app`. I titoli si accorciano e, oltre il
 * limite, le voci in più si contano soltanto (il capo le ritrova per id).
 */
export function implementMessage(appName: string, items: ImplementItem[], roundNumber?: number): string {
  const head = `Implementa il piano di sviluppo dell'App «${oneLine(appName)}».`;
  const how =
    "Questo è un lavoro nuovo, anche se il lavoro precedente della squadra è finito o chiuso: non chiamare `chiudi_lavoro`. Leggi le voci approvate con `leggi_piano_app` e proponi subito con `proponi_piano` un PLAN nuovo (obiettivo nuovo, un compito per voce con il campo `issue` quando la voce ne ha una; i compiti già finiti del PLAN precedente puoi toglierli); quando è approvato, assegna i compiti nell'ordine delle dipendenze.";
  const cycle = roundNumber === undefined ? "" : ` Sono le voci del giro ${roundNumber} del ciclo di evoluzione automatica: il ciclo approva da solo il PLAN.`;
  if (items.length === 0) return `${head}${cycle} Lavora su tutte le voci approvate del piano.\n${how}`;
  const intro = `${head}${cycle} Lavora solo su ${items.length === 1 ? "questa voce" : `queste ${items.length} voci`} (id di \`leggi_piano_app\`):`;
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
