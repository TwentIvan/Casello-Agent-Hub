// Messaggi fissi degli inneschi: mai testo delle app o del DB.
export const TRIGGER_MESSAGES = {
  notFound: "innesco non trovato",
  tooMany: "troppi inneschi",
  nameTaken: "nome già usato",
  toolNotUsable: "lo strumento non può essere usato da un innesco",
  toolNoLonger: "lo strumento non è più utilizzabile dall'innesco",
  invalidPath: "percorso non valido",
  invalidArgs: "argomenti non validi",
  cursorFieldRequired: "indica il campo del cursore",
  wrongKindFields: "campi non ammessi per questo tipo di innesco",
  listNotFound: "elenco non trovato nella risposta",
  unrecognized: "risposta non riconosciuta",
  budgetWait: "in attesa: tetto di spesa raggiunto",
  // Giro di sorveglianza: chiamata al tool fallita (mai il testo della risposta) o errore interno.
  toolFailed: "chiamata allo strumento non riuscita",
  pollFailed: "giro non riuscito: riprova più tardi",
  queueFull: "in attesa: troppe run in coda per l'agente",
  notActive: "innesco non attivo",
  badSignature: "firma non valida",
  toolInUse: "lo strumento è usato da un innesco: elimina prima l'innesco",
  // Regole di forma della configurazione (spec §3.1, §3.4).
  invalidName: "nome obbligatorio, al massimo 80 caratteri",
  invalidInterval: "intervallo non valido: da 60 a 86400 secondi",
  instructionsTooLong: "istruzioni troppo lunghe: al massimo 2000 caratteri",
  argsTooLarge: "argomenti troppo grandi: al massimo 8 KB",
  invalidFilter: "filtro non valido",
} as const;
