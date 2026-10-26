import type { AiProvider } from "../ai/providers";
import { authorFor, canonicalModelKey, directProviderFor, providerModelId, providerSlugFor } from "./canonical";
import { catalogKeysFor, familyAndVersion, normalizeModelId } from "./normalize";
import type { RegistryProvider } from "./provider-registry-data";
import type { ModelMode, SourceEntry, SourceName } from "./sources";

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
      status: statusFor(deprecationDate, now),
      deprecationDate,
      sources,
    });
  }
  return records;
}

function statusFor(deprecationDate: Date | null, now: Date): CatalogRecord["status"] {
  return !deprecationDate ? "available" : deprecationDate.getTime() <= now.getTime() ? "retired" : "deprecated";
}

/**
 * Aggiornamento parziale: per i modelli già nel catalogo, i campi che venivano da una fonte caduta
 * restano quelli precedenti (con la loro fonte) e lo stato si ricalcola dalla dismissione. Funzione pura.
 */
export function keepFailedSourceFields(
  records: CatalogRecord[],
  before: CatalogRecord[],
  failed: SourceName[],
  now: Date,
): CatalogRecord[] {
  if (!failed.length) return records;
  const prev = new Map(before.map((r) => [`${r.provider}\u0000${r.modelId}`, r]));
  return records.map((rec) => {
    const old = prev.get(`${rec.provider}\u0000${rec.modelId}`);
    if (!old) return rec;
    const out: CatalogRecord = { ...rec, sources: { ...rec.sources } };
    const kept = (field: SourcedField) => {
      const src = old.sources[field];
      if (!src || !failed.includes(src)) return false;
      out.sources[field] = src;
      return true;
    };
    if (kept("price")) {
      out.priceInput = old.priceInput;
      out.priceOutput = old.priceOutput;
    }
    if (kept("contextTokens")) out.contextTokens = old.contextTokens;
    if (kept("supportsTools")) out.supportsTools = old.supportsTools;
    if (kept("releasedAt")) out.releasedAt = old.releasedAt;
    if (kept("deprecationDate")) out.deprecationDate = old.deprecationDate;
    out.status = statusFor(out.deprecationDate, now);
    return out;
  });
}

/** Un modello presso un provider; identità (provider, id presso il provider). */
export interface OfferRecord {
  provider: string;
  providerModelId: string;
  canonicalKey: string;
  priceInput: number | null;
  priceOutput: number | null;
  contextTokens: number | null;
  supportsTools: boolean | null;
  status: "available" | "deprecated" | "retired";
  deprecationDate: Date | null;
  sources: Partial<Record<Exclude<SourcedField, "releasedAt">, SourceName>>;
}

/** Il modello indipendente dal provider: i campi vengono dalla voce più informativa. */
export interface ModelRecord {
  canonicalKey: string;
  author: string;
  family: string;
  version: string;
  mode: ModelMode;
  supportsTools: boolean | null;
  supportsVision: boolean | null;
  supportsReasoning: boolean | null;
  releasedAt: Date | null;
}

export interface DiscoveredProvider {
  slug: string;
  /** Nome originale di `litellm_provider`. */
  name: string;
  count: number;
}

type OfferGroup = { provider: string; providerModelId: string; bySource: Partial<Record<SourceName, SourceEntry>> };

/** Prima voce non nulla di un campo, nell'ordine dato. */
const firstOf = <T>(entries: SourceEntry[], pick: (e: SourceEntry) => T | null): T | null => {
  for (const e of entries) {
    const v = pick(e);
    if (v !== null) return v;
  }
  return null;
};

/** Ordine fisso dei tipi quando le voci di un modello non concordano; gli altri in ordine alfabetico. */
const MODE_PRIORITY: ModelMode[] = ["chat", "responses", "completion"];
const modeRank = (m: ModelMode) => (MODE_PRIORITY.includes(m) ? MODE_PRIORITY.indexOf(m) : MODE_PRIORITY.length);
const byMode = (a: ModelMode, b: ModelMode) => modeRank(a) - modeRank(b) || a.localeCompare(b);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byKey = (a: SourceEntry, b: SourceEntry) => cmp(a.key, b.key) || cmp(a.litellmProvider ?? "", b.litellmProvider ?? "");

/** Data in coda all'id OpenRouter (dopo l'autore): è uno snapshot, non il modello. */
const DATED_TAIL = /[-@](\d{8}|\d{4}-\d{2}-\d{2})$/;

/** Vero se almeno uno è vero, falso se tutti falsi, altrimenti null. */
const anyTrue = (values: (boolean | null)[]): boolean | null =>
  values.includes(true) ? true : values.length > 0 && values.every((v) => v === false) ? false : null;

/**
 * Fonde le voci delle fonti in modelli (indipendenti dal provider) e offerte (modello presso un provider).
 * Ogni voce entra: LiteLLM sotto il provider del registro (o uno scoperto, elencato in `discovered`),
 * OpenRouter sotto `openrouter` e, se un provider del registro serve direttamente l'autore, anche come
 * riserva per l'offerta di quel provider con lo stesso id, solo se LiteLLM l'ha già prodotta. Precedenze delle offerte come `mergeCatalog`;
 * nome e rilascio del modello da OpenRouter se c'è. Funzione pura.
 */
export function mergeUniversal(
  entries: SourceEntry[],
  registry: RegistryProvider[],
  now: Date,
): { models: ModelRecord[]; offers: OfferRecord[]; discovered: DiscoveredProvider[] } {
  const groups = new Map<string, OfferGroup>();
  const discovered = new Map<string, DiscoveredProvider>();
  // Dati di OpenRouter per un provider diretto: solo riserva di un'offerta che LiteLLM ha già prodotto
  const fallbacks: { id: string; entry: SourceEntry }[] = [];
  // Più voci della stessa fonte sulla stessa offerta (alias LiteLLM del provider, id che differiscono solo per
  // maiuscole): vince l'alias che viene prima nel registro, a parità la chiave minore (poi il nome LiteLLM minore). Non dipende dall'ordine.
  const aliasRank = (provider: string, e: SourceEntry) => {
    const aliases = registry.find((p) => p.slug === provider)?.litellm ?? [];
    const i = e.litellmProvider ? aliases.indexOf(e.litellmProvider) : -1;
    return i < 0 ? aliases.length : i;
  };
  const preferred = (provider: string, a: SourceEntry | undefined, b: SourceEntry) =>
    !a ? b : (aliasRank(provider, b) - aliasRank(provider, a) || byKey(b, a)) < 0 ? b : a;
  const add = (provider: string, modelId: string, entry: SourceEntry) => {
    if (!modelId) return;
    const id = `${provider}\u0000${modelId}`;
    let g = groups.get(id);
    if (!g) {
      g = { provider, providerModelId: modelId, bySource: {} };
      groups.set(id, g);
    }
    g.bySource[entry.source] = preferred(provider, g.bySource[entry.source], entry);
  };

  for (const entry of entries) {
    if (entry.source === "openrouter") {
      const id = providerModelId(entry);
      add("openrouter", id, entry);
      const direct = directProviderFor(entry, registry);
      if (direct) fallbacks.push({ id: `${direct}\u0000${normalizeModelId(entry.key.slice(entry.key.indexOf("/") + 1))}`, entry });
      continue;
    }
    const { slug, known } = providerSlugFor(entry, registry);
    if (!known) {
      const d = discovered.get(slug);
      const name = entry.litellmProvider ?? "";
      if (!d) discovered.set(slug, { slug, name, count: 1 });
      else {
        d.count++;
        if (name < d.name) d.name = name;
      }
    }
    add(slug, providerModelId(entry), entry);
  }
  for (const f of fallbacks) {
    const g = groups.get(f.id);
    if (g) g.bySource.openrouter = preferred(g.provider, g.bySource.openrouter, f.entry);
  }

  const offers: OfferRecord[] = [];
  const byModel = new Map<string, { offers: OfferRecord[]; ordered: SourceEntry[][] }>();
  for (const g of groups.values()) {
    const order: SourceName[] = g.provider === "openrouter" ? ["openrouter", "litellm"] : ["litellm", "openrouter"];
    const ordered = order.flatMap((s) => (g.bySource[s] ? [g.bySource[s]] : []));
    const sources: OfferRecord["sources"] = {};

    const priced = ordered.find((e) => e.priceInput !== null && e.priceOutput !== null);
    if (priced) sources.price = priced.source;
    const ctx = ordered.find((e) => e.contextTokens !== null);
    if (ctx) sources.contextTokens = ctx.source;
    const tools = ordered.find((e) => e.supportsTools !== null);
    if (tools) sources.supportsTools = tools.source;
    const deprecationDate = g.bySource.litellm?.deprecationDate ?? null;
    if (deprecationDate) sources.deprecationDate = "litellm";

    const offer: OfferRecord = {
      provider: g.provider,
      providerModelId: g.providerModelId,
      canonicalKey: canonicalModelKey(g.providerModelId),
      priceInput: priced?.priceInput ?? null,
      priceOutput: priced?.priceOutput ?? null,
      contextTokens: ctx?.contextTokens ?? null,
      supportsTools: tools?.supportsTools ?? null,
      status: statusFor(deprecationDate, now),
      deprecationDate,
      sources,
    };
    offers.push(offer);
    let m = byModel.get(offer.canonicalKey);
    if (!m) {
      m = { offers: [], ordered: [] };
      byModel.set(offer.canonicalKey, m);
    }
    m.offers.push(offer);
    m.ordered.push(ordered);
  }

  const models: ModelRecord[] = [];
  for (const [canonicalKey, m] of byModel) {
    const all = m.ordered.flat().sort(byKey);
    // Voce OpenRouter di riferimento: quella senza data in coda (il modello, non uno snapshot), poi la chiave minore
    const openrouter =
      all
        .filter((e) => e.source === "openrouter")
        .sort((a, b) => Number(DATED_TAIL.test(a.key)) - Number(DATED_TAIL.test(b.key)) || byKey(a, b))[0] ?? null;
    const slash = openrouter?.key.indexOf("/") ?? -1;
    const named = openrouter?.name ? openrouter : (all.find((e) => e.name) ?? null);
    const { family, version } = familyAndVersion(canonicalKey, named?.name ?? null);
    // Il tipo di LiteLLM prevale (OpenRouter è sempre chat); se le voci non concordano, priorità fissa
    const modes = all.filter((e) => e.source === "litellm").map((e) => e.mode).sort(byMode);
    const mode: ModelMode = modes[0] ?? "chat";
    models.push({
      canonicalKey,
      author: authorFor(canonicalKey, slash > 0 ? openrouter!.key.slice(0, slash) : null),
      family,
      version,
      mode,
      supportsTools: anyTrue(m.offers.map((o) => o.supportsTools)),
      supportsVision: anyTrue(m.ordered.map((o) => firstOf(o, (e) => e.supportsVision))),
      supportsReasoning: anyTrue(m.ordered.map((o) => firstOf(o, (e) => e.supportsReasoning))),
      releasedAt: openrouter?.releasedAt ?? firstOf(all, (e) => e.releasedAt),
    });
  }
  return { models, offers, discovered: [...discovered.values()] };
}

/** Come `keepFailedSourceFields`, sulle offerte (chiave provider + id presso il provider). Funzione pura. */
export function keepFailedOfferFields(
  offers: OfferRecord[],
  before: OfferRecord[],
  failed: SourceName[],
  now: Date,
): OfferRecord[] {
  if (!failed.length) return offers;
  const prev = new Map(before.map((r) => [`${r.provider}\u0000${r.providerModelId}`, r]));
  return offers.map((rec) => {
    const old = prev.get(`${rec.provider}\u0000${rec.providerModelId}`);
    if (!old) return rec;
    const out: OfferRecord = { ...rec, sources: { ...rec.sources } };
    const kept = (field: keyof OfferRecord["sources"]) => {
      const src = old.sources[field];
      if (!src || !failed.includes(src)) return false;
      out.sources[field] = src;
      return true;
    };
    if (kept("price")) {
      out.priceInput = old.priceInput;
      out.priceOutput = old.priceOutput;
    }
    if (kept("contextTokens")) out.contextTokens = old.contextTokens;
    if (kept("supportsTools")) out.supportsTools = old.supportsTools;
    if (kept("deprecationDate")) out.deprecationDate = old.deprecationDate;
    out.status = statusFor(out.deprecationDate, now);
    return out;
  });
}
