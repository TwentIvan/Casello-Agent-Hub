import type { RegistryProvider } from "./provider-registry-data";
import { normalizeModelId } from "./normalize";
import type { SourceEntry } from "./sources";

/** Funzioni pure che portano una voce di fonte a provider, id presso il provider, chiave canonica e autore. */

const SLUG_RE = /[^a-z0-9]+/g;

/** Slug del provider di una voce; `known` dice se viene dal registro. Sempre conforme a `^[a-z0-9_-]{1,64}$`. */
export function providerSlugFor(entry: SourceEntry, registry: RegistryProvider[]): { slug: string; known: boolean } {
  if (entry.source === "openrouter") return { slug: "openrouter", known: true };
  const name = entry.litellmProvider;
  const hit = name ? registry.find((p) => p.litellm.includes(name)) : undefined;
  if (hit) return { slug: hit.slug, known: true };
  const slug = (name ?? "").toLowerCase().replace(SLUG_RE, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return { slug: slug || "sconosciuto", known: false };
}

/** Provider del registro che serve direttamente un modello `autore/modello` di OpenRouter (senza varianti). */
export function directProviderFor(entry: SourceEntry, registry: RegistryProvider[]): string | null {
  if (entry.source !== "openrouter" || entry.key.includes(":")) return null;
  const i = entry.key.indexOf("/");
  if (i <= 0 || i === entry.key.length - 1) return null;
  const author = entry.key.slice(0, i);
  return registry.find((p) => p.openrouterAuthor === author)?.slug ?? null;
}

/** Id del modello presso il provider: la chiave senza il prefisso `<litellm_provider>/`, normalizzata. */
export function providerModelId(entry: SourceEntry): string {
  const prefix = entry.litellmProvider ? `${entry.litellmProvider}/` : null;
  const rest = entry.source === "litellm" && prefix && entry.key.startsWith(prefix) ? entry.key.slice(prefix.length) : entry.key;
  return normalizeModelId(rest);
}

const REGION_PREFIXES = ["us.", "eu.", "apac.", "global.", "us-gov.", "au.", "jp."];
const AUTHOR_PREFIXES = ["anthropic.", "meta.", "amazon.", "mistral.", "cohere.", "ai21.", "deepseek.", "qwen."];

/** Code generiche (`v1.1`, `dev`, `pro`...): da sole non identificano un modello, serve anche il segmento prima. */
const GENERIC_TAIL = /^(v?\d+([.-]\d+)*|dev|schnell|pro|max|ultra|base|latest|preview|turbo|mini|free)$/;

/** Chiave comune a tutti i provider che offrono lo stesso modello (Bedrock, Vertex, diretto...). */
export function canonicalModelKey(providerModelId: string): string {
  const segs = providerModelId.toLowerCase().split("/");
  let k = segs.pop() ?? providerModelId.toLowerCase();
  for (const p of REGION_PREFIXES) if (k.startsWith(p)) { k = k.slice(p.length); break; }
  for (const p of AUTHOR_PREFIXES) if (k.startsWith(p)) { k = k.slice(p.length); break; }
  k = k.replace(/-v\d+:\d+$/, "").replace(/@\d{8}$/, "").replace(/:\d+$/, "").replace(/_/g, "-");
  // Coda generica: si tiene anche il segmento precedente, per non unire modelli diversi (`flux/dev`, `flux-pro/v1.1`)
  while (GENERIC_TAIL.test(k.split("/")[0] ?? k) && segs.length > 0) {
    k = `${(segs.pop() ?? "").replace(/_/g, "-")}/${k}`;
  }
  return k;
}

const OPENROUTER_AUTHORS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", "meta-llama": "Meta", mistralai: "Mistral",
  qwen: "Qwen", deepseek: "DeepSeek", "x-ai": "xAI", "z-ai": "Z.ai", moonshotai: "Moonshot",
  minimax: "MiniMax", cohere: "Cohere",
};

const FAMILY_AUTHORS: { prefixes: string[]; author: string }[] = [
  { prefixes: ["claude"], author: "Anthropic" },
  { prefixes: ["gpt", "o1", "o3", "o4"], author: "OpenAI" },
  { prefixes: ["gemini", "gemma"], author: "Google" },
  { prefixes: ["llama"], author: "Meta" },
  { prefixes: ["mistral", "ministral", "codestral", "magistral", "devstral", "pixtral"], author: "Mistral" },
  { prefixes: ["qwen"], author: "Qwen" },
  { prefixes: ["deepseek"], author: "DeepSeek" },
  { prefixes: ["grok"], author: "xAI" },
  { prefixes: ["glm"], author: "Z.ai" },
  { prefixes: ["kimi"], author: "Moonshot" },
];

/** Autore del modello: dal prefisso di OpenRouter se c'è, altrimenti dalla famiglia nell'id. */
export function authorFor(canonicalKey: string, openrouterAuthor: string | null): string {
  if (openrouterAuthor) {
    return OPENROUTER_AUTHORS[openrouterAuthor] ?? openrouterAuthor.charAt(0).toUpperCase() + openrouterAuthor.slice(1);
  }
  const hit = FAMILY_AUTHORS.find((f) => f.prefixes.some((p) => canonicalKey.startsWith(p)));
  return hit?.author ?? "Sconosciuto";
}
