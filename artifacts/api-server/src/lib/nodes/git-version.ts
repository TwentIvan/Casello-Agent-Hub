import { compareVersions } from "./manifest";

/** Prima versione di Botcave Nodo che prepara da sola la copia Git dei compiti con codice. */
export const NODE_GIT_MIN_VERSION = "0.4.0";

/** Il nodo sa lavorare su una copia Git preparata da Botcave (versione nulla o non confrontabile = no). */
export function nodeSupportsGit(version: string | null): boolean {
  if (version === null) return false;
  const cmp = compareVersions(version, NODE_GIT_MIN_VERSION);
  return cmp !== null && cmp >= 0;
}
