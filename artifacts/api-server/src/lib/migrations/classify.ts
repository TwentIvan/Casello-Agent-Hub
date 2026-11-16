// Classifica uno script di migrazione: additivo o distruttivo (puro).
// La regola è prudente: un falso positivo sposta lo script in un `-post`, mai il contrario.
import { dollarTagLength, isEStringStart, quotedEnd, splitSql } from "./split.js";

export const MIGRATION_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.sql$/;

export function isPostMigration(name: string): boolean {
  return name.endsWith("-post.sql");
}

/** Toglie commenti e contenuto delle stringhe `'…'` ed `E'…'`; i corpi `$$…$$` restano (si controllano). */
function strip(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out += " ";
    } else if (c === '"') {
      // identificatore tra virgolette: sostituito da un segnaposto, così \S+ lo legge come una parola
      i = quotedEnd(sql, i, '"', false);
      out += " IDENT ";
    } else if (isEStringStart(sql, i)) {
      // stessa lettura di splitSql: \' non chiude la stringa
      i = quotedEnd(sql, i + 1, "'", true);
      out += " ''";
    } else if (c === "'") {
      i = quotedEnd(sql, i, "'", false);
      out += "''";
    } else if (c === "$" && dollarTagLength(sql, i) > 0) {
      i += dollarTagLength(sql, i);
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return normalize(out);
}

function normalize(text: string): string {
  return text.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Istruzioni che possono eseguire SQL scritto dentro stringhe o corpi: blocchi DO, funzioni e procedure
 * (anche con il corpo tra `'…'`), EXECUTE, regole, trigger e le funzioni di sistema che eseguono testo.
 * Per queste si controlla anche il testo grezzo, stringhe e commenti compresi (falsi positivi ammessi).
 */
const CODE_RE = /\b(?:DO|FUNCTION|PROCEDURE|EXECUTE|CALL|PREPARE|RULE|TRIGGER|PROGRAM)\b|DBLINK|_TO_XML|PG_BACKGROUND/;

/**
 * Impostazioni che cambiano come il server legge le stringhe (barre rovesciate, codifica): dopo, `splitSql` non
 * sarebbe più allineato al server. Si cercano nel testo grezzo, anche dentro stringhe (`set_config('…')`) e commenti.
 */
const SESSION_RE = /STANDARD_CONFORMING_STRINGS|CLIENT_ENCODING|BACKSLASH_QUOTE|\bSET\s+NAMES\b/;

/** Nomi di oggetto noti dopo DROP: solo questi entrano nel motivo (mai un identificatore dell'istruzione). */
const DROP_OBJECTS = new Set([
  "ACCESS", "AGGREGATE", "CAST", "COLLATION", "COLUMN", "CONVERSION", "DATABASE", "DOMAIN", "EVENT", "EXTENSION",
  "FOREIGN", "FUNCTION", "GROUP", "INDEX", "LANGUAGE", "OPERATOR", "OWNED", "POLICY", "PROCEDURE", "PUBLICATION",
  "ROLE", "ROUTINE", "RULE", "SCHEMA", "SEQUENCE", "SERVER", "STATISTICS", "SUBSCRIPTION", "TABLE", "TABLESPACE",
  "TEXT", "TRANSFORM", "TRIGGER", "TYPE", "USER", "VIEW",
]);

/** Ogni DROP, con la parola che lo segue (per il motivo e per i casi ammessi). */
const DROP_RE = /\bDROP\b\s*([A-Z_]*)/g;
/** Ammessi ovunque: parole riservate, quindi mai il nome di una colonna senza virgolette. */
const DROP_ALLOWED_RE = /^\s*(?:CONSTRAINT|NOT\s+NULL|DEFAULT)\b/;
/**
 * IDENTITY ed EXPRESSION non sono riservate (`ALTER TABLE t DROP identity` toglie la colonna «identity»): ammesse solo
 * subito dopo `ALTER [COLUMN] <colonna>`, cioè `ALTER COLUMN c DROP IDENTITY [IF EXISTS]`.
 */
const DROP_COLUMN_ATTR_RE = /^\s*(?:IDENTITY|EXPRESSION)\b/;
const ALTER_COLUMN_BEFORE_RE = /\bALTER\s+(?:COLUMN\s+)?(?!TABLE\b)\S+\s*$/;
const ALTER_TABLE_RE = /\bALTER\s+TABLE\b/;

/** Ogni DELETE è distruttivo (anche MERGE … THEN DELETE), tranne l'azione di una chiave esterna (ON DELETE CASCADE…). */
const DELETE_RE = /\bDELETE\b/g;
const FK_ACTION_RE = /^\s*(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)\b/;
const ON_BEFORE_RE = /\bON\s*$/;

const RULES: { reason: string; re: RegExp }[] = [
  // COPY … TO/FROM PROGRAM esegue un comando del sistema
  { reason: "COPY PROGRAM", re: /\bPROGRAM\b/ },
  { reason: "RENAME", re: /\bRENAME\b/ },
  { reason: "TRUNCATE", re: /\bTRUNCATE\b/ },
  { reason: "ALTER COLUMN TYPE", re: /\bALTER (?:COLUMN )?\S+ (?:SET DATA )?TYPE\b/ },
  { reason: "SET NOT NULL", re: /\bALTER (?:COLUMN )?\S+ SET NOT NULL\b/ },
];

function check(text: string, add: (r: string) => void): void {
  for (const m of text.matchAll(DROP_RE)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + 4, m.index + 40);
    if (DROP_ALLOWED_RE.test(after)) continue;
    if (DROP_COLUMN_ATTR_RE.test(after) && ALTER_COLUMN_BEFORE_RE.test(before)) continue;
    const word = m[1] ?? "";
    if (word === "MATERIALIZED") add("DROP MATERIALIZED VIEW");
    else add(DROP_OBJECTS.has(word) ? `DROP ${word}` : "DROP");
    if (ALTER_TABLE_RE.test(before)) add("DROP COLUMN");
  }
  for (const m of text.matchAll(DELETE_RE)) {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (!(ON_BEFORE_RE.test(before) && FK_ACTION_RE.test(after))) add("DELETE");
  }
  for (const rule of RULES) if (rule.re.test(text)) add(rule.reason);
}

export function classifyMigration(
  name: string,
  sql: string,
): { destructive: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const add = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  if (isPostMigration(name)) add("-post");
  // Stessi a capo per tutti i chiamanti (esecutore e merge delle squadre): un \r da solo chiude un commento --
  const normalized = sql.replace(/\r\n?/g, "\n");
  for (const statement of splitSql(normalized)) {
    const text = strip(statement);
    check(text, add);
    if (SESSION_RE.test(normalize(statement))) add("impostazione di sessione");
    // SQL dinamico (EXECUTE '…', corpi tra '…' o $$…$$): anche il testo grezzo, così le parole nelle stringhe si vedono
    if (statement.includes("$") || CODE_RE.test(text)) check(normalize(statement), add);
  }
  return { destructive: reasons.length > 0, reasons };
}
