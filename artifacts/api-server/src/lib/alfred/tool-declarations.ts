/**
 * Dichiarazioni Gemini degli otto strumenti del centralino e dei quattro di memoria di Alfred (spec §4). Tipi dello schema di Gemini
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
    description: "Voci in attesa di una decisione dell'utente (azioni, piani, modifiche del piano, proposte con più passi).",
  },
  {
    name: "leggi_proposta",
    description: "Legge una proposta della coda: titolo, motivo e passi con numero e sintesi, da leggere uno per uno.",
    parameters: {
      type: "OBJECT",
      properties: { numero: { type: "INTEGER", description: "Numero della voce in coda" } },
      required: ["numero"],
    },
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
    name: "elenca_app",
    description: "App con un Responsabile di prodotto che puoi interpellare: slug, nome e una riga di descrizione.",
  },
  {
    name: "chiedi_al_responsabile",
    description:
      "Passa una richiesta completa al Responsabile di prodotto di un'App e attende fino a 25 secondi l'esito: risposta, errore e voci create in «Da confermare». Le sue scritture restano in coda.",
    parameters: {
      type: "OBJECT",
      properties: {
        richiesta: { type: "STRING", description: "La richiesta completa, al massimo 4000 caratteri" },
        app: { type: "STRING", description: "Slug o nome dell'App (da elenca_app); se manca vale Botcave" },
      },
      required: ["richiesta"],
    },
  },
  {
    name: "leggi_run",
    description: "Stato, esito, errore, costo e voci create di una run dell'utente.",
    parameters: {
      type: "OBJECT",
      properties: { id: { type: "INTEGER", description: "Id della run" } },
      required: ["id"],
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
        escludi: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "id dei passi da non eseguire, es. p3; solo per le proposte e con approva",
        },
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
  {
    name: "ricorda",
    description:
      "Salva un appunto sull'utente per le conversazioni future: solo un fatto o una preferenza stabile, breve (al massimo 300 caratteri). Mai credenziali, chiavi, password o token.",
    parameters: {
      type: "OBJECT",
      properties: { testo: { type: "STRING", description: "L'appunto, breve e stabile" } },
      required: ["testo"],
    },
  },
  {
    name: "aggiorna_appunto",
    description: "Sostituisce il testo di un appunto esistente (stesse regole di ricorda).",
    parameters: {
      type: "OBJECT",
      properties: {
        id: { type: "INTEGER", description: "Id dell'appunto" },
        testo: { type: "STRING", description: "Il nuovo testo" },
      },
      required: ["id", "testo"],
    },
  },
  {
    name: "dimentica",
    description: "Elimina un appunto che non vale più.",
    parameters: {
      type: "OBJECT",
      properties: { id: { type: "INTEGER", description: "Id dell'appunto" } },
      required: ["id"],
    },
  },
  {
    name: "cerca_nello_storico",
    description: "Cerca nei riassunti delle conversazioni passate con l'utente. Usalo solo quando serve ritrovare qualcosa; al massimo 5 risultati.",
    parameters: {
      type: "OBJECT",
      properties: { testo: { type: "STRING", description: "Parole da cercare" } },
      required: ["testo"],
    },
  },
];
