// File di istruzioni di un ruolo (spec §1): Markdown con il frontmatter dei sub-agent di Claude Code, salvato come
// skill specializzata della squadra con codice `ruolo-<key>`. Modulo puro.

export const INSTRUCTIONS_SKILL_PREFIX = "ruolo-";

export const INSTRUCTIONS_MESSAGES = {
  frontmatter: "il file deve iniziare con il frontmatter del ruolo",
  wrongName: (key: string) => `il nome nel frontmatter deve essere ${key}`,
} as const;

/** Scheletro del file: lo usa Lucius (nel prompt) e lo verificano i test. */
export const INSTRUCTIONS_TEMPLATE = [
  "---",
  "name: <key del ruolo>",
  "description: <una frase: quando il capo deve scegliere questo ruolo>",
  "---",
  "# <Nome del ruolo>",
  "",
  "## Identità",
  "## Responsabilità            (cosa fa; cosa NON fa e lascia ad altri ruoli)",
  "## Cosa ricevi                (dal capo: compito, PLAN, allegati)",
  "## Cosa consegni              (forma dell'esito con `riferisci`: stato, esito ≤ 300, dettaglio)",
  "## Come lavori                (procedura in passi)",
  "## Strumenti                  (quali usare e quando; livelli L2 = vanno in coda all'utente)",
  "## Limiti e quando fermarti   (quando riferire `blocked`, cosa non fare mai)",
  "## Criteri di qualità         (quando il lavoro è fatto)",
  "## Esempi                     (facoltativo)",
].join("\n");

export function instructionsSkillCode(roleKey: string): string {
  return `${INSTRUCTIONS_SKILL_PREFIX}${roleKey}`;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1).trim();
  return v;
}

/** Frontmatter `---` all'inizio del file con `name` = key del ruolo e `description` non vuota. */
export function parseInstructionsFile(
  markdown: string,
  roleKey: string,
): { ok: true; name: string; description: string } | { ok: false; error: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { ok: false, error: INSTRUCTIONS_MESSAGES.frontmatter };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { ok: false, error: INSTRUCTIONS_MESSAGES.frontmatter };
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
    if (m && !fields.has(m[1]!)) fields.set(m[1]!, unquote(m[2]!));
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (!name || !description) return { ok: false, error: INSTRUCTIONS_MESSAGES.frontmatter };
  if (name !== roleKey) return { ok: false, error: INSTRUCTIONS_MESSAGES.wrongName(roleKey) };
  return { ok: true, name, description };
}
