import type { AiProvider } from "../ai/providers";
import type { SourceEntry } from "./sources";

/** Id di modello confrontabile tra le fonti: senza `models/` iniziale, in minuscolo. */
export function normalizeModelId(id: string): string {
  return id.replace(/^models\//i, "").toLowerCase();
}

type CatalogKey = { provider: AiProvider; modelId: string };

const OPENROUTER_PREFIXES: Record<string, AiProvider> = {
  "deepseek/": "deepseek",
  "google/": "gemini",
  "mistralai/": "mistral",
};

const LITELLM_PROVIDERS: Record<string, AiProvider> = {
  deepseek: "deepseek",
  gemini: "gemini",
  mistral: "mistral",
  groq: "groq",
  together_ai: "together",
  openrouter: "openrouter",
};

/** Le chiavi (provider, modello) sotto cui una voce di fonte entra nel catalogo. */
export function catalogKeysFor(entry: SourceEntry): CatalogKey[] {
  if (entry.source === "openrouter") {
    const keys: CatalogKey[] = [{ provider: "openrouter", modelId: normalizeModelId(entry.key) }];
    for (const [prefix, provider] of Object.entries(OPENROUTER_PREFIXES)) {
      if (!entry.key.startsWith(prefix)) continue;
      const rest = entry.key.slice(prefix.length);
      // Le varianti (`:free`, ...) esistono solo su OpenRouter
      if (rest && !rest.includes(":")) keys.push({ provider, modelId: normalizeModelId(rest) });
    }
    return keys;
  }
  const provider = entry.litellmProvider ? LITELLM_PROVIDERS[entry.litellmProvider] : undefined;
  if (!provider || !entry.litellmProvider) return [];
  const prefix = `${entry.litellmProvider}/`;
  const rest = entry.key.startsWith(prefix) ? entry.key.slice(prefix.length) : entry.key;
  return rest ? [{ provider, modelId: normalizeModelId(rest) }] : [];
}

const FAMILIES: { label: string; prefixes: string[] }[] = [
  { label: "Gemini", prefixes: ["gemini"] },
  { label: "Gemma", prefixes: ["gemma"] },
  { label: "DeepSeek", prefixes: ["deepseek"] },
  { label: "Mistral", prefixes: ["mistral", "ministral", "codestral", "magistral", "devstral", "pixtral"] },
  { label: "Llama", prefixes: ["llama"] },
  { label: "Qwen", prefixes: ["qwen"] },
  { label: "GPT", prefixes: ["gpt"] },
  { label: "Claude", prefixes: ["claude"] },
  { label: "Grok", prefixes: ["grok"] },
  { label: "Kimi", prefixes: ["kimi"] },
  { label: "GLM", prefixes: ["glm"] },
];

/** Famiglia e versione leggibili di un modello, ricavate dall'id e dal nome (se c'è). */
export function familyAndVersion(modelId: string, name: string | null): { family: string; version: string } {
  const base = (modelId.split("/").pop() ?? modelId).toLowerCase();
  let family = "";
  let matched = "";
  for (const f of FAMILIES) {
    const p = f.prefixes.find((x) => base.startsWith(x));
    if (p) {
      family = f.label;
      matched = p;
      break;
    }
  }
  if (!family) {
    matched = base.split("-")[0] ?? base;
    family = matched.charAt(0).toUpperCase() + matched.slice(1);
  }

  let version: string;
  if (name) {
    let n = name.replace(/^[^:]+:\s*/, "").trim();
    const lower = n.toLowerCase();
    for (const w of [matched, family.toLowerCase()]) {
      if (w && lower.startsWith(w)) {
        n = n.slice(w.length);
        break;
      }
    }
    version = n.trim();
  } else {
    version = base.slice(matched.length).replace(/^-+/, "").replace(/-/g, " ").trim();
  }
  return { family, version };
}
