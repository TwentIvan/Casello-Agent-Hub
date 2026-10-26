import type { AiProvider } from "./providers";

/**
 * Prezzi di listino per i provider il cui `/models` non li fornisce (USD per milione di token,
 * input senza cache). Usati alla scoperta dei modelli quando il provider non dà prezzi; il catalogo
 * automatico sostituirà questa tabella.
 */
export interface PriceSeedEntry {
  provider: AiProvider;
  modelId: string;
  /** USD per milione di token in ingresso (cache miss). */
  input: number;
  /** USD per milione di token in uscita. */
  output: number;
  /** Data (anno-mese) dei prezzi. */
  updated: string;
}

// Prezzi DeepSeek da verificare su api-docs.deepseek.com; modificabili dalla console
export const PRICE_SEED: PriceSeedEntry[] = [
  { provider: "deepseek", modelId: "deepseek-chat", input: 0.28, output: 0.42, updated: "2025-09" },
  { provider: "deepseek", modelId: "deepseek-reasoner", input: 0.28, output: 0.42, updated: "2025-09" },
];

/** Voce della tabella seed per il modello del provider, se presente. */
export function findSeedPrice(provider: AiProvider, modelId: string): PriceSeedEntry | undefined {
  return PRICE_SEED.find((s) => s.provider === provider && s.modelId === modelId);
}
