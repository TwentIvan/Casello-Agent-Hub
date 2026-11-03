// Controllo dei testi prima di accodare un'azione di agente per la conferma dell'utente.
// Segnala due cose: segnaposto lasciati nel testo e menzioni "@nome" che non compaiono nel destinatario.
//
// Regole (volutamente semplici):
// - Segnaposto tra quadre: `[...]` con almeno una lettera dentro (`[]`, `[1]` non contano).
// - Segnaposto tra angolari: `<...>` che non è un tag HTML. Tag = nome con eventuale `/` iniziale o finale
//   e attributi solo se contengono `=` (`<br>`, `</p>`, `<a href="x">`). Quindi `<da definire>` conta.
// - `TODO`, `TBD`, `XXX` come parole intere, maiuscole; `???` come testo letterale.
// - Menzione: `@` a inizio stringa o dopo un carattere che non è lettera, cifra o `_` (così `a@b.it` non lo è),
//   seguito da lettere, cifre, `.`, `_`, `-`; il nome non termina con `.`, `-` o `_`.
//   È "nel destinatario" se il destinatario lo contiene, senza distinzione di maiuscole.
// Si controllano `summary` e tutti i valori stringa annidati in `args` (oggetti e array), in quest'ordine.
// Ogni problema compare una volta sola, nell'ordine di prima apparizione.

export interface QueuedTextInput {
  recipient: string;
  summary: string;
  args: Record<string, unknown>;
}

const BRACKET_RE = /\[[^[\]]*\]/g;
const ANGLE_RE = /<[^<>]*>/g;
const WORD_PLACEHOLDER_RE = /\b(?:TODO|TBD|XXX)\b/g;
const QUESTION_MARKS = "???";
const HTML_TAG_RE = /^\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*=[^<>]*)?\/?$/;
const MENTION_RE = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu;
const HAS_LETTER_RE = /\p{L}/u;

interface Hit {
  start: number;
  end: number;
  text: string;
}

function placeholderHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(BRACKET_RE)) {
    if (HAS_LETTER_RE.test(m[0].slice(1, -1))) {
      hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  for (const m of text.matchAll(ANGLE_RE)) {
    const inner = m[0].slice(1, -1);
    if (HAS_LETTER_RE.test(inner) && !HTML_TAG_RE.test(inner.trim())) {
      hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  for (const m of text.matchAll(WORD_PLACEHOLDER_RE)) {
    hits.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  let from = 0;
  for (let at = text.indexOf(QUESTION_MARKS); at !== -1; at = text.indexOf(QUESTION_MARKS, from)) {
    hits.push({ start: at, end: at + QUESTION_MARKS.length, text: QUESTION_MARKS });
    from = at + QUESTION_MARKS.length;
  }
  return hits;
}

// Un testo che sta dentro un segnaposto già segnalato (es. TODO in [TODO]) non si segnala due volte.
// Restituisce posizione e testo del problema, così placeholder e menzioni si ordinano per apparizione.
function textProblems(text: string, recipient: string): Array<{ at: number; problem: string }> {
  const hits = placeholderHits(text).sort((a, b) => a.start - b.start || b.end - a.end);
  const found: Array<{ at: number; problem: string }> = [];
  let covered = -1;
  for (const hit of hits) {
    if (hit.start < covered) continue;
    covered = hit.end;
    found.push({ at: hit.start, problem: `segnaposto "${hit.text}"` });
  }
  const target = recipient.toLowerCase();
  for (const m of text.matchAll(MENTION_RE)) {
    if (!target.includes(m[1].toLowerCase())) {
      found.push({ at: m.index, problem: `menzione "@${m[1]}" non nel destinatario` });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

function nestedStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) nestedStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) nestedStrings(item, out);
  }
  return out;
}

export function checkQueuedText(input: QueuedTextInput): string[] {
  const texts = [input.summary, ...nestedStrings(input.args, [])];
  const problems: string[] = [];
  for (const text of texts) {
    for (const { problem } of textProblems(text, input.recipient)) {
      if (!problems.includes(problem)) problems.push(problem);
    }
  }
  return problems;
}
