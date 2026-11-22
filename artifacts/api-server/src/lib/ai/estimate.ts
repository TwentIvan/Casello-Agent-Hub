import { ANALYSIS_DEFAULT_MAX_TOKENS } from "../architect/run-analysis";

/**
 * Arrotondamento a 6 decimali (USD, come `cost_usd`): un valore positivo non diventa mai 0 (al minimo
 * 0,000001), così la console può mostrare "< 0,0001 $" invece di "0 $".
 */
function roundUsd(n: number): number {
  const rounded = Math.round(n * 1e6) / 1e6;
  return n > 0 && rounded === 0 ? 1e-6 : rounded;
}

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Stima del costo di un'analisi cloud dai prezzi del modello (USD per milione di token): `GET /api/ai/estimate` e la voce
 * della nuova app da zero. Senza prezzi entrambi null.
 */
export function estimateAnalysisCost(
  prices: { priceInputPerMtok: string | null; priceOutputPerMtok: string | null },
  maxTokens?: number,
): { maxUsd: number | null; typicalUsd: number | null } {
  const priceIn = toNumber(prices.priceInputPerMtok);
  const priceOut = toNumber(prices.priceOutputPerMtok);
  if (priceIn === null || priceOut === null) return { maxUsd: null, typicalUsd: null };
  // Si ipotizza il 95% di token di input; il tipico è il 60% del tetto
  const max = ((maxTokens ?? ANALYSIS_DEFAULT_MAX_TOKENS) * (0.95 * priceIn + 0.05 * priceOut)) / 1e6;
  return { maxUsd: roundUsd(max), typicalUsd: roundUsd(0.6 * max) };
}
