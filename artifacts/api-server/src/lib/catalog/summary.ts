import type { DiscoveredProvider, OfferRecord } from "./merge";

/** Una novità su un'offerta: `modelId` è l'id presso il provider, `version` quella del modello. */
export interface OfferChange {
  provider: string;
  modelId: string;
  version: string;
}

export interface OfferSummary {
  firstRun: boolean;
  added: OfferChange[];
  retired: OfferChange[];
  deprecating: (OfferChange & { deprecationDate: string })[];
  priceChanged: (OfferChange & {
    oldInput: number | null;
    oldOutput: number | null;
    newInput: number | null;
    newOutput: number | null;
  })[];
  /** Provider scoperti (creati) in questa esecuzione. */
  newProviders: DiscoveredProvider[];
  /** Modelli scoperti prima e non più elencati, per account verificato. */
  accounts: { accountId: number; userId: number; accountName: string; missing: string[] }[];
}

/**
 * Differenze tra due stati delle offerte: nuove, ritirate, in dismissione (nuova o con data cambiata), prezzo
 * cambiato (solo se noto prima e dopo); `versionOf` dà la versione leggibile del modello di un'offerta. Con
 * `before` vuoto è la prima esecuzione: niente liste.
 */
export function summarizeOffers(
  before: OfferRecord[],
  after: OfferRecord[],
  versionOf: (offer: OfferRecord) => string,
): Omit<OfferSummary, "accounts" | "newProviders"> {
  const key = (r: OfferRecord) => `${r.provider}\u0000${r.providerModelId}`;
  const ch = (r: OfferRecord): OfferChange => ({ provider: r.provider, modelId: r.providerModelId, version: versionOf(r) });
  const out: Omit<OfferSummary, "accounts" | "newProviders"> = { firstRun: before.length === 0, added: [], retired: [], deprecating: [], priceChanged: [] };
  if (out.firstRun) return out;

  const prev = new Map(before.map((r) => [key(r), r]));
  for (const now of after) {
    const old = prev.get(key(now));
    if (!old) {
      out.added.push(ch(now));
      continue;
    }
    if (now.status === "retired" && old.status !== "retired") out.retired.push(ch(now));
    if (
      now.status === "deprecated" &&
      now.deprecationDate &&
      (old.status !== "deprecated" || old.deprecationDate?.getTime() !== now.deprecationDate.getTime())
    ) {
      out.deprecating.push({ ...ch(now), deprecationDate: now.deprecationDate.toISOString().slice(0, 10) });
    }
    const bothKnown =
      old.priceInput !== null && old.priceOutput !== null && now.priceInput !== null && now.priceOutput !== null;
    if (bothKnown && (old.priceInput !== now.priceInput || old.priceOutput !== now.priceOutput)) {
      out.priceChanged.push({
        ...ch(now),
        oldInput: old.priceInput,
        oldOutput: old.priceOutput,
        newInput: now.priceInput,
        newOutput: now.priceOutput,
      });
    }
  }
  return out;
}
