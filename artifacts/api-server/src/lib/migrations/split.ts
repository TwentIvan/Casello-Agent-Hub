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
    } else if (c === "'" || c === '"') {
      hasCode = true;
      i++;
      while (i < text.length) {
        if (text[i] === c) {
          if (text[i + 1] === c) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
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
