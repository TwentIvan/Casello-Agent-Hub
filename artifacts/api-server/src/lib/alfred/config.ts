/** Costanti di Alfred, il maggiordomo vocale (spec: docs/superpowers/specs/2026-11-05-casello-alfred-design.md). */

/** Voci di Gemini Live ammesse (elenco fisso). */
export const ALFRED_VOICES: readonly string[] = ["Kore", "Charon", "Aoede", "Puck", "Fenrir", "Leda", "Orus", "Zephyr"];
export const DEFAULT_ALFRED_VOICE = "Kore";

const GEMINI_NATIVE_DEFAULT = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Base dell'API nativa di Gemini (modelli, token temporanei). Non è mai l'indirizzo dell'account: la variabile
 * `GEMINI_NATIVE_BASE` serve solo ai test e con `NODE_ENV=production` è ignorata.
 */
export function geminiNativeBase(): string {
  const override = process.env["GEMINI_NATIVE_BASE"];
  if (override && process.env["NODE_ENV"] !== "production") return override.replace(/\/+$/, "");
  return GEMINI_NATIVE_DEFAULT;
}

/** Nome del modello senza il prefisso `models/`. */
export function bareModelName(modelId: string): string {
  return modelId.replace(/^models\//i, "");
}

/** Idoneo ad Alfred dal solo nome: contiene `live` o `native-audio`, non `transcribe`, `translate` né `robotics`. */
export function isAlfredModelName(modelId: string): boolean {
  const name = bareModelName(modelId).toLowerCase();
  if (/transcribe|translate|robotics/.test(name)) return false;
  return name.includes("live") || name.includes("native-audio");
}

/** Testi fissi di Alfred (mai il testo di Gemini né del DB). */
export const ALFRED_MESSAGES = {
  modelUnsuitable: "modello non adatto ad Alfred",
  voiceUnavailable: "voce non disponibile",
  geminiKeyRejected: "chiave Gemini rifiutata: controlla l'account in Account",
  geminiUnreachable: "Gemini non raggiungibile",
} as const;

/** Tempo massimo di una chiamata a Gemini. */
export const GEMINI_TIMEOUT_MS = 15_000;
