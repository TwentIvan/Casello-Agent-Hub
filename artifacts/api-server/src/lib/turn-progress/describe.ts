// Testi dei passi mostrati in console mentre un personaggio lavora a un turno di chat.
// Funzione pura: frase fissa per strumento, degli argomenti entra solo un elenco chiuso di campi
// (percorsi, testi cercati, glob, slug, codici skill, numero), mai contenuti, appunti o messaggi.

const MAX_FIELD = 80;
const FALLBACK = "Usa uno strumento";

type Args = Record<string, unknown>;

function parseArgs(raw: string): Args {
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {};
  } catch {
    return {};
  }
}

/** Campo di testo ripulito: controlli e a capo in spazi, spazi ridotti, al più 80 caratteri. Vuoto o non stringa: null. */
function text(args: Args, key: string): string | null {
  const v = args[key];
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return null;
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

function int(args: Args, key: string): number | null {
  const v = args[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

type Describer = (args: Args) => string;

const fixed =
  (phrase: string): Describer =>
  () =>
    phrase;

const readSkill: Describer = (a) => {
  const code = text(a, "code");
  return code ? `Legge la skill ${code}` : "Legge una skill";
};

const DESCRIBERS: Record<string, Describer> = {
  // Solo l'host dell'indirizzo: percorso e query possono contenere token.
  leggi_pagina_web: (a) => {
    const raw = typeof a.url === "string" ? a.url : "";
    let host: string | null = null;
    try {
      host = text({ host: new URL(raw).hostname.toLowerCase() }, "host");
    } catch {
      host = null;
    }
    return host ? `Legge la pagina ${host}` : "Legge una pagina web";
  },
  leggi_file: (a) => {
    const path = text(a, "percorso");
    if (!path) return "Legge un file";
    const from = int(a, "daRiga");
    const to = int(a, "aRiga");
    return from !== null && to !== null ? `Legge ${path}, righe ${from}–${to}` : `Legge ${path}`;
  },
  elenca_cartella: (a) => {
    if (typeof a.percorso !== "string") return "Guarda una cartella";
    const path = text(a, "percorso");
    return path ? `Guarda la cartella ${path}` : "Guarda la radice del codice";
  },
  cerca_nel_codice: (a) => {
    const q = text(a, "testo");
    if (!q) return "Cerca nel codice";
    const glob = text(a, "glob");
    return glob ? `Cerca "${q}" nel codice in ${glob}` : `Cerca "${q}" nel codice`;
  },
  read_item: (a) => {
    const ref = text(a, "ref");
    return ref ? `Rilegge la voce ${ref} del piano` : "Rilegge una voce del piano";
  },
  read_app: (a) => {
    const slug = text(a, "slug");
    return slug ? `Legge l'app ${slug}` : "Legge un'app";
  },
  propose: fixed("Prepara una scheda"),
  leggi_squadra: fixed("Legge la squadra"),
  leggi_skill: readSkill,
  leggi_versione_skill: readSkill,
  leggi_strumento: fixed("Legge gli strumenti dell'app"),
  leggi_strumenti_app: fixed("Legge gli strumenti dell'app"),
  leggi_agente: fixed("Legge l'agente"),
  leggi_modello: fixed("Legge il modello di squadra"),
  elenca_agenti: fixed("Scorre gli agenti"),
  elenca_skill: fixed("Scorre le skill"),
  elenca_modelli: fixed("Scorre i modelli di squadra"),
  passa_a: fixed("Prepara il passaggio di consegne"),
  ricorda: fixed("Prende un appunto"),
  aggiorna_appunto: fixed("Prende un appunto"),
  dimentica: fixed("Toglie un appunto"),
  cerca_nello_storico: fixed("Cerca negli incontri passati"),
  squadre_stato: fixed("Controlla le squadre"),
  squadra_dettaglio: fixed("Legge il dettaglio di una squadra"),
  bollettino: fixed("Legge il bollettino"),
  coda_da_confermare: fixed("Guarda la coda da confermare"),
  leggi_proposta: (a) => {
    const n = int(a, "numero");
    return n !== null ? `Legge la proposta n. ${n}` : "Legge una proposta";
  },
  scrivi_al_capo: fixed("Scrive al capo della squadra"),
  elenca_app: fixed("Scorre le app"),
  chiedi_al_responsabile: (a) => {
    const app = text(a, "app");
    return app ? `Chiede al Responsabile di ${app}` : "Chiede al Responsabile di prodotto";
  },
  leggi_run: fixed("Legge l'esito di una run"),
};

export function describeStep(name: string, rawArgs: string): string {
  try {
    const describer = Object.hasOwn(DESCRIBERS, name) ? DESCRIBERS[name] : undefined;
    if (describer) return describer(parseArgs(rawArgs));
    if (name.startsWith("proponi_")) return "Prepara una scheda";
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}
