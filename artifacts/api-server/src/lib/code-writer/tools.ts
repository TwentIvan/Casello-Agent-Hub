import { CODE_READ_LIMITS } from "../code-reader/tools";
import { internalTool } from "../teams/role-tools";
import type { CatalogTool } from "../tools/types";
import { CODE_SESSION_LIMITS } from "./session";

/**
 * Strumenti del codice per i ruoli `cloud` con `code ≠ none` (spec §4): li esegue `CodeTaskSession`, mai `executeTool`.
 * Lettura (L0 per natura) per `read` e `write`; scrittura, commit, PR e CI solo per `write`.
 */

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const CODE_READ_TOOLS: CatalogTool[] = [
  internalTool(
    "elenca_cartella",
    "Elenca file e cartelle (le cartelle finiscono con '/') del repository sul branch del compito, con le modifiche non committate. Sola lettura.",
    obj(
      {
        percorso: { type: "string", description: "Cartella da elencare, relativa alla radice ('' per la radice)" },
        profondita: { type: "integer", description: "Profondità da 1 a 5 (default 1)" },
      },
      ["percorso"],
    ),
  ),
  internalTool(
    "leggi_file",
    `Legge un file del repository con le righe numerate (massimo ${CODE_READ_LIMITS.maxReadLines} righe per chiamata); un file modificato si legge dalla copia di lavoro. Sola lettura.`,
    obj(
      {
        percorso: { type: "string", description: "Percorso del file, relativo alla radice" },
        daRiga: { type: "integer", description: "Prima riga da leggere (da 1)" },
        aRiga: { type: "integer", description: "Ultima riga da leggere (compresa)" },
      },
      ["percorso"],
    ),
  ),
  internalTool(
    "cerca_nel_codice",
    "Cerca un testo (o un'espressione regolare) nel repository, copia di lavoro compresa; restituisce percorso:riga: testo con una riga di contesto. Sola lettura.",
    obj(
      {
        testo: { type: "string", description: "Testo da cercare (senza distinzione tra maiuscole e minuscole) o espressione regolare" },
        glob: { type: "string", description: "Filtro sui percorsi, es. 'src/**/*.ts'" },
        regex: { type: "boolean", description: "true per interpretare testo come espressione regolare" },
      },
      ["testo"],
    ),
  ),
  internalTool(
    "leggi_issue",
    `Legge un'issue del repository: titolo, stato, etichette e corpo (al più ${CODE_SESSION_LIMITS.maxIssueChars} caratteri). Sola lettura.`,
    obj({ numero: { type: "integer", minimum: 1, description: "Numero dell'issue" } }, ["numero"]),
  ),
];

export const CODE_WRITE_TOOLS: CatalogTool[] = [
  internalTool(
    "scrivi_file",
    "Crea o sostituisce un file nella copia di lavoro (non ancora committato). Niente workflow della CI, .env o binari.",
    obj(
      {
        percorso: { type: "string", description: "Percorso del file, relativo alla radice" },
        contenuto: { type: "string", description: "Contenuto completo del file (testo UTF-8)" },
      },
      ["percorso", "contenuto"],
    ),
  ),
  internalTool(
    "modifica_file",
    "Sostituisce nella copia di lavoro un testo esatto che compare una sola volta nel file; se compare più volte allarga il contesto.",
    obj(
      {
        percorso: { type: "string", description: "Percorso del file, relativo alla radice" },
        vecchio: { type: "string", description: "Testo esatto da sostituire (da 1 a 20 000 caratteri)" },
        nuovo: { type: "string", description: "Testo nuovo (al più 200 000 caratteri)" },
      },
      ["percorso", "vecchio", "nuovo"],
    ),
  ),
  internalTool(
    "elimina_file",
    "Segna un file come eliminato nella copia di lavoro.",
    obj({ percorso: { type: "string", description: "Percorso del file, relativo alla radice" } }, ["percorso"]),
  ),
  internalTool(
    "crea_commit",
    `Crea un commit con tutte le modifiche della copia di lavoro sul branch del compito (al più ${CODE_SESSION_LIMITS.maxCommits} per esecuzione).`,
    obj({ messaggio: { type: "string", description: "Messaggio del commit, da 1 a 500 caratteri" } }, ["messaggio"]),
  ),
  internalTool(
    "apri_pr",
    "Apre una PR in bozza dal branch del compito al branch base; se ne esiste già una aperta la restituisce senza modificarla.",
    obj(
      {
        titolo: { type: "string", description: "Titolo della PR, da 1 a 200 caratteri" },
        corpo: { type: "string", description: "Descrizione della PR, al più 10 000 caratteri" },
      },
      ["titolo", "corpo"],
    ),
  ),
  internalTool(
    "leggi_esito_ci",
    "Legge lo stato della CI sull'ultimo commit della PR del compito: check falliti, annotazioni e coda dei log. Sola lettura.",
    obj({}, []),
  ),
];
