import type { PageAction } from "@workspace/api-client-react";

export const MAX_ACTIONS_PER_PAGE = 6;
export const MAX_ACTIONS_PER_APP = 40;

/** Raggruppa le azioni per tipo di pagina, nell'ordine di prima comparsa. */
export function groupActions(actions: PageAction[]): Array<{ page: string; actions: PageAction[] }> {
  const groups: Array<{ page: string; actions: PageAction[] }> = [];
  for (const action of actions) {
    const group = groups.find((g) => g.page === action.page);
    if (group) group.actions.push(action);
    else groups.push({ page: action.page, actions: [action] });
  }
  return groups;
}

/** Sposta di `delta` posti l'azione `index` della pagina `page`, restando nella pagina; fuori dai limiti non cambia nulla. */
export function moveAction(list: PageAction[], page: string, index: number, delta: number): PageAction[] {
  const positions = list.flatMap((a, i) => (a.page === page ? [i] : []));
  const target = index + delta;
  if (index < 0 || index >= positions.length || target < 0 || target >= positions.length) return list;
  const next = list.slice();
  const [from, to] = [positions[index], positions[target]];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
