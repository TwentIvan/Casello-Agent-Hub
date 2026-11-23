import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";

/** File del modello che si possono personalizzare (testo più voci spostate senza contenuto). */
export const MAX_FILES = 200;
const MARKER = ".botcave/modello.json";
const PLACEHOLDERS = ["__SLUG__", "__APP_NAME__", "__DOMAIN__"] as const;

export interface PersonalizeVars {
  slug: string;
  name: string;
  domain: string;
  brief: string;
}

/** Voce dell'albero Git del modello (percorso → modo e sha del blob). */
export interface TemplateEntry {
  mode: string;
  sha: string;
}

export interface PersonalizeResult {
  /** Percorso → nuovo testo; `null` = file da eliminare. */
  changes: Map<string, string | null>;
  /** Modo dei percorsi nuovi dei file di testo rinominati, preso dal percorso vecchio (es. 100755). */
  modes: Map<string, string>;
  /** Voci non di testo (binari, cartelle ignorate, file grandi) spostate riusando il blob. */
  reuse: { path: string; mode: string; sha: string }[];
}

function hasPlaceholder(path: string): boolean {
  return PLACEHOLDERS.some((p) => path.includes(p));
}

/**
 * Personalizza i file del modello: sostituisce i segnaposto in percorsi e contenuti (non sotto `.github/`),
 * scrive AGENT_BRIEF.md e aggiunge lo slug al marcatore. Le voci dell'albero che `files` non contiene (binari,
 * cartelle ignorate, file oltre 1 MiB) sotto un percorso con segnaposto si spostano con il loro blob e modo.
 */
export function personalizeFiles(
  files: Map<string, string>,
  vars: PersonalizeVars,
  entries: Map<string, TemplateEntry> = new Map(),
): PersonalizeResult | { error: string } {
  const sub = (s: string) =>
    s
      .split("__SLUG__").join(vars.slug)
      .split("__APP_NAME__").join(vars.name)
      .split("__DOMAIN__").join(vars.domain);

  const moved: [string, TemplateEntry][] = [];
  for (const [path, entry] of entries) {
    if (files.has(path) || path.startsWith(".github/") || !hasPlaceholder(path)) continue;
    // Un collegamento o un sottomodulo non si sposta: Botcave non li scrive
    if (entry.mode === "120000" || entry.mode === "160000") return { error: M.pathRefused };
    moved.push([path, entry]);
  }
  if (files.size + moved.length > MAX_FILES) return { error: M.tooManyFiles };

  const changes = new Map<string, string | null>();
  const modes = new Map<string, string>();
  const reuse: PersonalizeResult["reuse"] = [];
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
      const mode = entries.get(path)?.mode;
      if (mode && mode !== "100644") modes.set(newPath, mode);
    } else if (newContent !== content) {
      changes.set(path, newContent);
    }
  }
  for (const [path, entry] of moved) {
    const newPath = sub(path);
    if (newPath === path) continue;
    reuse.push({ path: newPath, mode: entry.mode, sha: entry.sha });
    changes.set(path, null);
  }
  if (files.get("AGENT_BRIEF.md") !== vars.brief) changes.set("AGENT_BRIEF.md", vars.brief);
  return { changes, modes, reuse };
}
