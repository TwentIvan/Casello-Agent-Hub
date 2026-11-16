// Classifica uno script di migrazione: additivo o distruttivo (puro).
// La regola è prudente: un falso positivo sposta lo script in un `-post`, mai il contrario.
import { dollarTagLength, splitSql } from "./split.js";

export const MIGRATION_NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.sql$/;

export function isPostMigration(name: string): boolean {
  return name.endsWith("-post.sql");
}

/** Toglie commenti e contenuto delle stringhe `'…'`; i corpi `$$…$$` restano (si controllano). */
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
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      out += " IDENT ";
    } else if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      out += "''";
    } else if (c === "$" && dollarTagLength(sql, i) > 0) {
      i += dollarTagLength(sql, i);
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out.toUpperCase().replace(/\s+/g, " ").trim();
}

const DROP_OBJECT_RE =
  /\bDROP (TABLE|TYPE|SCHEMA|VIEW|MATERIALIZED VIEW|FUNCTION|PROCEDURE|SEQUENCE|INDEX|TRIGGER|DOMAIN|EXTENSION|POLICY)\b/g;

const RULES: { reason: string; re: RegExp }[] = [
  {
    reason: "DROP COLUMN",
    re: /\bALTER TABLE\b.*\bDROP (?!CONSTRAINT\b|NOT NULL\b|DEFAULT\b|IDENTITY\b|EXPRESSION\b)/,
  },
  { reason: "RENAME", re: /\bRENAME\b/ },
  { reason: "TRUNCATE", re: /\bTRUNCATE\b/ },
  { reason: "DELETE FROM", re: /\bDELETE FROM\b/ },
  { reason: "ALTER COLUMN TYPE", re: /\bALTER (?:COLUMN )?\S+ (?:SET DATA )?TYPE\b/ },
  { reason: "SET NOT NULL", re: /\bALTER (?:COLUMN )?\S+ SET NOT NULL\b/ },
];

export function classifyMigration(
  name: string,
  sql: string,
): { destructive: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const add = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  if (isPostMigration(name)) add("-post");
  for (const statement of splitSql(sql)) {
    const text = strip(statement);
    for (const m of text.matchAll(DROP_OBJECT_RE)) add(`DROP ${m[1]}`);
    for (const rule of RULES) if (rule.re.test(text)) add(rule.reason);
  }
  return { destructive: reasons.length > 0, reasons };
}
