// Divide il testo di un file SQL in istruzioni (puro, lineare).
// Il `;` separa solo fuori da stringhe, identificatori, dollar quoting e commenti.

/** Lunghezza del delimitatore dollar `$tag$` che comincia in `i`, o 0 se non lo è. */
export function dollarTagLength(text: string, i: number): number {
  if (text[i] !== "$") return 0;
  if (i > 0 && /[A-Za-z0-9_$]/.test(text[i - 1]!)) return 0;
  let j = i + 1;
  if (j < text.length && /[A-Za-z_]/.test(text[j]!)) {
    j++;
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
  }
  return text[j] === "$" ? j - i + 1 : 0;
}

/** `E'…'` (o `e'…'`) che comincia in `i`: la E non deve far parte di un identificatore più lungo. */
export function isEStringStart(text: string, i: number): boolean {
  const c = text[i];
  if ((c !== "E" && c !== "e") || text[i + 1] !== "'") return false;
  return i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1]!);
}

/**
 * Fine (indice dopo la chiusura) del testo tra `quote` che si apre in `i`.
 * La virgoletta raddoppiata non chiude; con `backslash` (stringhe E) `\x` salta sempre il carattere dopo.
 */
export function quotedEnd(text: string, i: number, quote: string, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (backslash && ch === "\\") j += 2;
    else if (ch === quote) {
      if (text[j + 1] === quote) j += 2;
      else return j + 1;
    } else j++;
  }
  return text.length;
}

export function splitSql(input: string): string[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const out: string[] = [];
  let start = 0;
  let hasCode = false;
  const flush = (end: number) => {
    const s = text.slice(start, end).trim();
    if (s && hasCode) out.push(s);
    start = end + 1;
    hasCode = false;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (isEStringStart(text, i)) {
      // stringa con escape a barra rovesciata: \' non la chiude
      hasCode = true;
      i = quotedEnd(text, i + 1, "'", true);
    } else if (c === "'" || c === '"') {
      hasCode = true;
      i = quotedEnd(text, i, c, false);
    } else if (c === "$" && dollarTagLength(text, i) > 0) {
      hasCode = true;
      const tag = text.slice(i, i + dollarTagLength(text, i));
      const close = text.indexOf(tag, i + tag.length);
      i = close === -1 ? text.length : close + tag.length;
    } else if (c === ";") {
      flush(i);
      i++;
    } else {
      if (!/\s/.test(c)) hasCode = true;
      i++;
    }
  }
  flush(text.length);
  return out;
}
