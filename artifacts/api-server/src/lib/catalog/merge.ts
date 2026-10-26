import type { AiProvider } from "../ai/providers";
import { catalogKeysFor, familyAndVersion } from "./normalize";
import type { SourceEntry, SourceName } from "./sources";

type SourcedField = "price" | "contextTokens" | "supportsTools" | "releasedAt" | "deprecationDate";

export interface CatalogRecord {
  provider: AiProvider;
  modelId: string;
  family: string;
  version: string;
  releasedAt: Date | null;
  priceInput: number | null;
  priceOutput: number | null;
  contextTokens: number | null;
  supportsTools: boolean | null;
  status: "available" | "deprecated" | "retired";
  deprecationDate: Date | null;
  sources: Partial<Record<SourcedField, SourceName>>;
}

/**
 * Fonde le voci delle fonti in un record per (provider, modello). Precedenza: per `openrouter` i dati
 * vengono da OpenRouter e poi da LiteLLM, per gli altri provider da LiteLLM e poi da OpenRouter; la data
 * di rilascio solo da OpenRouter, la dismissione solo da LiteLLM. Funzione pura.
 */
export function mergeCatalog(entries: SourceEntry[], now: Date): CatalogRecord[] {
  const groups = new Map<string, { provider: AiProvider; modelId: string; bySource: Partial<Record<SourceName, SourceEntry>> }>();
  for (const entry of entries) {
    for (const k of catalogKeysFor(entry)) {
      const id = `${k.provider}\u0000${k.modelId}`;
      let g = groups.get(id);
      if (!g) {
        g = { provider: k.provider, modelId: k.modelId, bySource: {} };
        groups.set(id, g);
      }
      // Chiave ripetuta nella stessa fonte: vince la prima
      g.bySource[entry.source] ??= entry;
    }
  }

  const records: CatalogRecord[] = [];
  for (const g of groups.values()) {
    const order: SourceName[] = g.provider === "openrouter" ? ["openrouter", "litellm"] : ["litellm", "openrouter"];
    const ordered = order.flatMap((s) => (g.bySource[s] ? [g.bySource[s]] : []));
    const sources: CatalogRecord["sources"] = {};

    const priced = ordered.find((e) => e.priceInput !== null && e.priceOutput !== null);
    if (priced) sources.price = priced.source;
    const ctx = ordered.find((e) => e.contextTokens !== null);
    if (ctx) sources.contextTokens = ctx.source;
    const tools = ordered.find((e) => e.supportsTools !== null);
    if (tools) sources.supportsTools = tools.source;

    const releasedAt = g.bySource.openrouter?.releasedAt ?? null;
    if (releasedAt) sources.releasedAt = "openrouter";
    const deprecationDate = g.bySource.litellm?.deprecationDate ?? null;
    if (deprecationDate) sources.deprecationDate = "litellm";

    const { family, version } = familyAndVersion(g.modelId, ordered.find((e) => e.name)?.name ?? null);
    records.push({
      provider: g.provider,
      modelId: g.modelId,
      family,
      version,
      releasedAt,
      priceInput: priced?.priceInput ?? null,
      priceOutput: priced?.priceOutput ?? null,
      contextTokens: ctx?.contextTokens ?? null,
      supportsTools: tools?.supportsTools ?? null,
      status: !deprecationDate ? "available" : deprecationDate.getTime() <= now.getTime() ? "retired" : "deprecated",
      deprecationDate,
      sources,
    });
  }
  return records;
}
