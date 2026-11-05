/**
 * Dichiarazioni Gemini dei sette strumenti di Alfred (spec §4). Tipi dello schema di Gemini
 * (`OBJECT`, `INTEGER`, `STRING`); finiscono nel token temporaneo, il browser non può cambiarle.
 */
export const ALFRED_TOOL_DECLARATIONS: Record<string, unknown>[] = [
  {
    name: "squadre_stato",
    description: "Stato delle squadre attive dell'utente: una riga per squadra.",
  },
  {
    name: "squadra_dettaglio",
    description: "Dettaglio di una squadra: obiettivo, stato del piano, ultimi compiti ed eventi.",
    parameters: {
      type: "OBJECT",
      properties: { id: { type: "INTEGER", description: "Numero della squadra" } },
      required: ["id"],
    },
  },
  {
    name: "bollettino",
    description: "Novità non lette delle squadre; le segna come lette.",
  },
  {
    name: "coda_da_confermare",
    description: "Voci in attesa di una decisione dell'utente (azioni, piani, modifiche del piano).",
  },
  {
    name: "scrivi_al_capo",
    description: "Manda un messaggio al capo di una squadra. Solo dopo la conferma esplicita dell'utente sul testo.",
    parameters: {
      type: "OBJECT",
      properties: {
        id: { type: "INTEGER", description: "Numero della squadra" },
        testo: { type: "STRING", description: "Testo del messaggio, al massimo 4000 caratteri" },
      },
      required: ["id", "testo"],
    },
  },
  {
    name: "prepara_decisione",
    description:
      "Prepara l'approvazione o il rifiuto di una voce in coda e restituisce numero e sintesi da leggere all'utente. Non decide nulla: serve poi conferma_decisione.",
    parameters: {
      type: "OBJECT",
      properties: {
        numero: { type: "INTEGER", description: "Numero della voce in coda" },
        decisione: { type: "STRING", enum: ["approva", "rifiuta"], description: "Decisione proposta" },
        nota: { type: "STRING", description: "Nota del rifiuto, al massimo 500 caratteri; solo con rifiuta" },
      },
      required: ["numero", "decisione"],
    },
  },
  {
    name: "conferma_decisione",
    description:
      "Conferma la decisione preparata, solo dopo un sì esplicito dell'utente alla domanda appena posta. Il codice viene dal risultato di prepara_decisione e non va mai pronunciato.",
    parameters: {
      type: "OBJECT",
      properties: { codice: { type: "STRING", description: "Codice restituito da prepara_decisione" } },
      required: ["codice"],
    },
  },
];
