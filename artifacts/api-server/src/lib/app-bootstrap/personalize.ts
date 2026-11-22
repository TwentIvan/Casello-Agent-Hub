import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";

const MAX_FILES = 200;
const MARKER = ".botcave/modello.json";

export interface PersonalizeVars {
  slug: string;
  name: string;
  domain: string;
  brief: string;
}

/**
 * Personalizza i file del modello: sostituisce i segnaposto in percorsi e contenuti (non sotto `.github/`),
 * scrive AGENT_BRIEF.md e aggiunge lo slug al marcatore. `null` = file da eliminare.
 */
export function personalizeFiles(
  files: Map<string, string>,
  vars: PersonalizeVars,
): { changes: Map<string, string | null> } | { error: string } {
  if (files.size > MAX_FILES) return { error: M.tooManyFiles };
  const sub = (s: string) =>
    s
      .split("__SLUG__").join(vars.slug)
      .split("__APP_NAME__").join(vars.name)
      .split("__DOMAIN__").join(vars.domain);
  const changes = new Map<string, string | null>();
  for (const [path, content] of files) {
    if (path === MARKER) {
      let obj: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
      } catch {
        obj = {};
      }
      const next = JSON.stringify({ ...obj, slug: vars.slug }, null, 2) + "\n";
      if (next !== content) changes.set(path, next);
      continue;
    }
    if (path.startsWith(".github/")) continue;
    const newPath = sub(path);
    const newContent = sub(content);
    if (newPath !== path) {
      changes.set(newPath, newContent);
      changes.set(path, null);
    } else if (newContent !== content) {
      changes.set(path, newContent);
    }
  }
  if (files.get("AGENT_BRIEF.md") !== vars.brief) changes.set("AGENT_BRIEF.md", vars.brief);
  return { changes };
}
