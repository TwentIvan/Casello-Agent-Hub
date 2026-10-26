import type { AiProvider } from "../ai/providers";
import type { CatalogRecord } from "./merge";

export interface CatalogChange {
  provider: AiProvider;
  modelId: string;
  version: string;
}

export interface CatalogSummary {
  firstRun: boolean;
  added: CatalogChange[];
  retired: CatalogChange[];
  deprecating: (CatalogChange & { deprecationDate: string })[];
  priceChanged: (CatalogChange & {
    oldInput: number | null;
    oldOutput: number | null;
    newInput: number | null;
    newOutput: number | null;
  })[];
  accounts: { accountId: number; userId: number; accountName: string; missing: string[] }[];
}

const keyOf = (r: { provider: AiProvider; modelId: string }) => `${r.provider}\u0000${r.modelId}`;
const change = (r: CatalogRecord): CatalogChange => ({ provider: r.provider, modelId: r.modelId, version: r.version });

/** Differenze tra due stati del catalogo. Con `before` vuoto è la prima esecuzione: niente liste. */
export function summarizeCatalog(before: CatalogRecord[], after: CatalogRecord[]): Omit<CatalogSummary, "accounts"> {
  const out: Omit<CatalogSummary, "accounts"> = { firstRun: before.length === 0, added: [], retired: [], deprecating: [], priceChanged: [] };
  if (out.firstRun) return out;

  const prev = new Map(before.map((r) => [keyOf(r), r]));
  for (const now of after) {
    const old = prev.get(keyOf(now));
    if (!old) {
      out.added.push(change(now));
      continue;
    }
    if (now.status === "retired" && old.status !== "retired") out.retired.push(change(now));
    if (
      now.status === "deprecated" &&
      now.deprecationDate &&
      (old.status !== "deprecated" || old.deprecationDate?.getTime() !== now.deprecationDate.getTime())
    ) {
      out.deprecating.push({ ...change(now), deprecationDate: now.deprecationDate.toISOString().slice(0, 10) });
    }
    const bothKnown =
      old.priceInput !== null && old.priceOutput !== null && now.priceInput !== null && now.priceOutput !== null;
    if (bothKnown && (old.priceInput !== now.priceInput || old.priceOutput !== now.priceOutput)) {
      out.priceChanged.push({
        ...change(now),
        oldInput: old.priceInput,
        oldOutput: old.priceOutput,
        newInput: now.priceInput,
        newOutput: now.priceOutput,
      });
    }
  }
  return out;
}
