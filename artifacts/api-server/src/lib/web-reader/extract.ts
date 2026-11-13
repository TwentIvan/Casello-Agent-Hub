// Estrazione del testo leggibile da HTML, JSON e testo semplice (puro, senza rete).
import type { BodyKind } from "./fetch-page.js";

const TITLE_MAX = 200;
const SNIFF_BYTES = 2048;

/** Decodifica il corpo: charset dell'header o, per l'HTML, del meta; etichetta sconosciuta → UTF-8. */
export function decodeBody(body: Buffer, charset: string | null, kind: BodyKind): string {
  let label = charset?.trim() || null;
  if (!label && kind === "html") {
    const head = body.subarray(0, SNIFF_BYTES).toString("latin1");
    const m = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_:.-]+)/i.exec(head);
    label = m ? m[1]! : null;
  }
  try {
    return new TextDecoder(label ?? "utf-8", { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  copy: "©", reg: "®", trade: "™", euro: "€",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", szlig: "ß",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Auml: "Ä", Ccedil: "Ç", Egrave: "È", Eacute: "É",
  Ecirc: "Ê", Igrave: "Ì", Ograve: "Ò", Oacute: "Ó", Ouml: "Ö", Ugrave: "Ù", Uuml: "Ü",
};

function decodeEntities(s: string): string {
  return s.replace(
    /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,10}));/g,
    (all: string, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? all;
      const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex!, 16);
      if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    },
  );
}

// Caratteri di controllo, esclusi a capo e tabulazione.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function stripControl(s: string): string {
  return s.replace(CONTROL_RE, "");
}

function isBlankChar(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0xa0;
}

/** Toglie spazi, tabulazioni e NBSP ai due bordi con un ciclo lineare (niente regex ancorate a `$`: sarebbero quadratiche). */
function trimLine(l: string): string {
  let a = 0;
  let b = l.length;
  while (a < b && isBlankChar(l.charCodeAt(a))) a++;
  while (b > a && isBlankChar(l.charCodeAt(b - 1))) b--;
  return a === 0 && b === l.length ? l : l.slice(a, b);
}

/** Minuscole solo ASCII: la lunghezza non cambia mai (toLowerCase() su «İ» la allungherebbe e sfalserebbe gli indici). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** Righe tagliate, righe vuote al più due di fila, testo tagliato ai bordi. */
function tidyLines(s: string, maxBlank = 2): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(trimLine)
    .join("\n")
    .replace(new RegExp(`\\n{${maxBlank + 2},}`, "g"), "\n".repeat(maxBlank + 1))
    .trim();
}

function removeComments(s: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = s.indexOf("<!--", pos);
    if (start < 0) return out + s.slice(pos);
    out += s.slice(pos, start);
    const end = s.indexOf("-->", start + 4);
    if (end < 0) return out; // commento senza chiusura: via fino alla fine
    pos = end + 3;
  }
}

const REMOVED_BLOCKS = new Set(["script", "style", "noscript", "svg", "template", "iframe", "head"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "pre",
  "blockquote", "header", "footer", "nav", "main", "table", "ul", "ol", "dd", "dt",
]);
const TAG_NAME_RE = /^(\/?)([A-Za-z][A-Za-z0-9]*)/;

/** Posizione di `</name` seguito da un terminatore (`>`, spazio, `/`) a partire da `from`, o -1. */
function findClose(lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let pos = from;
  for (;;) {
    const idx = lower.indexOf(needle, pos);
    if (idx < 0) return -1;
    const c = lower.charAt(idx + needle.length);
    if (c === "" || c === ">" || c === "/" || /\s/.test(c)) return idx;
    pos = idx + needle.length;
  }
}

function oneLine(s: string): string {
  return stripControl(decodeEntities(s)).replace(/\s+/g, " ").trim();
}

/** Titolo: ricerca con indexOf (nessuna regex con `[^>]*` ripetuto). */
function readTitle(html: string, lower: string): string | null {
  let pos = 0;
  for (;;) {
    const idx = lower.indexOf("<title", pos);
    if (idx < 0) return null;
    const c = lower.charAt(idx + 6);
    if (c === ">" || c === "/" || /\s/.test(c)) {
      const gt = html.indexOf(">", idx);
      if (gt < 0) return null;
      const close = findClose(lower, "title", gt + 1);
      if (close < 0) return null;
      return oneLine(html.slice(gt + 1, close)).slice(0, TITLE_MAX) || null;
    }
    pos = idx + 6;
  }
}

/**
 * Scanner lineare: una sola ricerca di `<` e di `>` per tag, ogni passo avanza.
 * Un `<` senza `>` o un blocco da scartare senza chiusura tolgono tutto il resto.
 */
function stripTags(html: string, lower: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const m = TAG_NAME_RE.exec(html.slice(lt + 1, lt + 30));
    if (!m) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (!closing && REMOVED_BLOCKS.has(name)) {
      const close = findClose(lower, name, gt + 1);
      if (close < 0) break;
      const end = html.indexOf(">", close);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (!closing && /^h[1-3]$/.test(name)) out.push(`\n${"#".repeat(Number(name[1]))} `);
    else if (!closing && name === "li") out.push("\n- ");
    else if (closing && (name === "ul" || name === "ol")) out.push("\n\n");
    else if (BLOCK_TAGS.has(name)) out.push("\n");
    i = gt + 1;
  }
  return out.join("");
}

function extractHtml(html: string): { title: string | null; text: string } {
  const title = readTitle(html, asciiLower(html));
  const clean = removeComments(html);
  const s = stripControl(decodeEntities(stripTags(clean, asciiLower(clean)))).replace(/[ \t]+/g, " ");
  return { title, text: tidyLines(s, 1) };
}

const MAX_JSON_DEPTH = 200;

/**
 * Stima per eccesso la lunghezza dell'output di `JSON.stringify(x, null, 2)` con una sola scansione lineare
 * (senza costruire nulla). Ogni apertura, virgola e chiusura porta «a capo + indentazione», ogni `:` uno spazio;
 * stringhe e primitivi contano com'erano, gli spazi fuori dalle stringhe no. Si ferma appena supera `limit`
 * o la profondità supera `MAX_JSON_DEPTH` (in entrambi i casi risponde `Infinity`).
 */
function prettyLengthEstimate(text: string, limit: number): number {
  let depth = 0;
  let len = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      len++;
      if (c === 0x5c) {
        i++;
        len++;
      } else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) {
      inStr = true;
      len++;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > MAX_JSON_DEPTH) return Infinity;
      len += 1 + 1 + 2 * depth;
    } else if (c === 0x5d || c === 0x7d) {
      len += 1 + 1 + 2 * depth;
      depth--;
    } else if (c === 0x2c) len += 1 + 1 + 2 * depth;
    else if (c === 0x3a) len += 2;
    else if (c > 0x20) len++;
    if (len > limit) return Infinity;
  }
  return len;
}

/** Estrae titolo e testo leggibile secondo il tipo di contenuto. */
export function extractText(text: string, kind: BodyKind): { title: string | null; text: string } {
  if (kind === "html") return extractHtml(text);
  if (kind === "json") {
    try {
      const parsed: unknown = JSON.parse(text);
      // Annidamenti profondi o larghi gonfiano l'indentazione: la dimensione si stima prima, senza
      // costruire la stringa; oltre 4 volte l'originale (o 200 livelli) si tiene il testo com'era.
      if (prettyLengthEstimate(text, 4 * text.length) <= 4 * text.length) {
        const pretty = JSON.stringify(parsed, null, 2);
        if (pretty.length <= 4 * text.length) return { title: null, text: pretty };
      }
      return { title: null, text: tidyLines(stripControl(text)) };
    } catch {
      return { title: null, text: tidyLines(stripControl(text)) };
    }
  }
  return { title: null, text: tidyLines(stripControl(text)) };
}
