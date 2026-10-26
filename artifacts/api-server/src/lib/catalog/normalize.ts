/** Id di modello confrontabile tra le fonti: senza `models/` iniziale, in minuscolo. */
export function normalizeModelId(id: string): string {
  return id.replace(/^models\//i, "").toLowerCase();
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
    version = n.replace(/^[-\s]+/, "").trim();
  } else {
    version = base.slice(matched.length).replace(/^-+/, "").replace(/-/g, " ").trim();
  }
  // Id che è tutto famiglia (`o1`): la versione è l'id stesso, leggibile
  if (!version) version = base.replace(/-/g, " ");
  return { family, version };
}
