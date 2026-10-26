/**
 * Configurazione della GitHub App "Casello". Tutte le variabili sono facoltative: se ne manca una
 * GitHub è disattivato e l'API parte comunque. La chiave privata e il client secret non escono mai
 * da qui verso log, risposte o messaggi d'errore.
 */

import { createPrivateKey } from "node:crypto";
import { logger } from "../logger";

export interface GithubConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM (PKCS#1 come la dà GitHub, o PKCS#8). */
  privateKey: string;
  /** Base delle API REST, senza barra finale. */
  apiBase: string;
  /** Base del sito (OAuth, pagina di installazione), senza barra finale. */
  webBase: string;
}

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_WEB_BASE = "https://github.com";

function read(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

const REQUIRED = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"] as const;

/** Logger usato per la diagnostica (iniettabile nei test). */
export type ConfigLogger = { warn: (obj: object, msg: string) => void };

/**
 * null se manca una variabile o la chiave privata non è leggibile; in entrambi i casi, se la
 * configurazione è stata iniziata, un avviso con i soli nomi delle variabili (mai i valori).
 * `GITHUB_API_BASE`/`GITHUB_WEB_BASE` (solo test) sono ignorate in produzione.
 */
export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env, log: ConfigLogger = logger): GithubConfig | null {
  const missing = REQUIRED.filter((name) => read(env, name) === null);
  if (missing.length === REQUIRED.length) return null;
  if (missing.length > 0) {
    log.warn({ missing }, "Configurazione GitHub incompleta: GitHub resta disattivato");
    return null;
  }
  const appId = read(env, "GITHUB_APP_ID")!;
  const slug = read(env, "GITHUB_APP_SLUG")!;
  const clientId = read(env, "GITHUB_APP_CLIENT_ID")!;
  const clientSecret = read(env, "GITHUB_APP_CLIENT_SECRET")!;
  const rawKey = read(env, "GITHUB_APP_PRIVATE_KEY")!;

  // Nei pannelli delle variabili la PEM arriva spesso su una riga con `\n` letterali
  const privateKey = rawKey.replace(/\\n/g, "\n");
  try {
    createPrivateKey(privateKey);
  } catch {
    // Mai l'errore di OpenSSL né la chiave: solo il nome della variabile
    log.warn({}, "GITHUB_APP_PRIVATE_KEY non valida: GitHub resta disattivato");
    return null;
  }
  const overridable = env.NODE_ENV !== "production";
  const apiBase = (overridable ? read(env, "GITHUB_API_BASE") : null) ?? DEFAULT_API_BASE;
  const webBase = (overridable ? read(env, "GITHUB_WEB_BASE") : null) ?? DEFAULT_WEB_BASE;
  return {
    appId,
    slug,
    clientId,
    clientSecret,
    privateKey,
    apiBase: apiBase.replace(/\/+$/, ""),
    webBase: webBase.replace(/\/+$/, ""),
  };
}

let cached: GithubConfig | null | undefined;

/** Configurazione dal processo, letta una sola volta. */
export function githubConfig(): GithubConfig | null {
  if (cached === undefined) cached = loadGithubConfig();
  return cached;
}

/** Solo per i test: la prossima `githubConfig()` rilegge le variabili d'ambiente. */
export function resetGithubConfigForTests(): void {
  cached = undefined;
}
