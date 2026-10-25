/**
 * Configurazione della GitHub App "Casello". Tutte le variabili sono facoltative: se ne manca una
 * GitHub è disattivato e l'API parte comunque. La chiave privata e il client secret non escono mai
 * da qui verso log, risposte o messaggi d'errore.
 */

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

/** null se manca una variabile. `GITHUB_API_BASE`/`GITHUB_WEB_BASE` (solo test) sono ignorate in produzione. */
export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig | null {
  const appId = read(env, "GITHUB_APP_ID");
  const slug = read(env, "GITHUB_APP_SLUG");
  const clientId = read(env, "GITHUB_APP_CLIENT_ID");
  const clientSecret = read(env, "GITHUB_APP_CLIENT_SECRET");
  const rawKey = read(env, "GITHUB_APP_PRIVATE_KEY");
  if (!appId || !slug || !clientId || !clientSecret || !rawKey) return null;

  // Nei pannelli delle variabili la PEM arriva spesso su una riga con `\n` letterali
  const privateKey = rawKey.replace(/\\n/g, "\n");
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
