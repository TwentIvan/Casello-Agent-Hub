// Esecuzione della ricetta di avvio (modalità «Riaccendi»): installazione, build, schema, servizi in background e attesa
// che ogni servizio risponda sul suo readyPath (al più 5 minuti).

import { clip, MAX_TIMEOUT_SEC, runShell } from "./shell";

/** Stessa forma di `TestRecipe` in artifacts/api-server/src/lib/collaudo/recipe.ts (pacchetti separati: non si importa). */
export type TestRecipe = {
  install: string[];
  build: string[];
  services: { name: string; command: string; port: number; readyPath: string }[];
  postgres: boolean;
  schema: string[];
  env: Record<string, string>;
  startUrl: string;
  login: string | null;
};

export type RecipeRunResult = { ok: boolean; output: string; port: number };
export type RecipeRunOptions = { readyTimeoutMs?: number; backgroundWaitMs?: number };

const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 1_000;

/** Postgres del servizio del workflow del repository di collaudo. */
export const RUNNER_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/postgres";

/** Ambiente dei comandi dell'App: quello della ricetta, più DATABASE_URL se serve Postgres e la ricetta non lo dà. */
export function recipeEnv(recipe: TestRecipe): Record<string, string> {
  const env = { ...recipe.env };
  if (recipe.postgres && env.DATABASE_URL === undefined) env.DATABASE_URL = RUNNER_DATABASE_URL;
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReady(port: number, readyPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}${readyPath}`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await res.body?.cancel();
      if (res.status < 500) return true;
    } catch {
      // non ancora in ascolto
    }
    await sleep(READY_POLL_MS);
  }
  return false;
}

export async function runRecipe(recipe: TestRecipe, root: string, opts: RecipeRunOptions = {}): Promise<RecipeRunResult> {
  const env = recipeEnv(recipe);
  const port = recipe.services[0]?.port ?? 0;
  const lines: string[] = [];
  const done = (ok: boolean, last?: string): RecipeRunResult => ({
    ok,
    output: clip([...lines, ...(last ? [last] : [])].join("\n")),
    port,
  });

  if (recipe.services.length === 0) return done(false, "la ricetta non ha servizi da avviare");

  for (const command of [...recipe.install, ...recipe.build, ...recipe.schema]) {
    const r = await runShell({ command, timeoutSec: MAX_TIMEOUT_SEC }, root, { env });
    if (!r.ok) return done(false, `passo non riuscito: ${command}\n${r.output}`);
    lines.push(`passo riuscito: ${command}`);
  }

  for (const service of recipe.services) {
    const r = await runShell({ command: service.command, background: true }, root, { env, backgroundWaitMs: opts.backgroundWaitMs });
    if (!r.ok) return done(false, `servizio ${service.name} non avviato\n${r.output}`);
    lines.push(`servizio ${service.name} avviato sulla porta ${service.port}`);
  }

  for (const service of recipe.services) {
    if (!(await waitReady(service.port, service.readyPath, opts.readyTimeoutMs ?? READY_TIMEOUT_MS))) {
      return done(false, `servizio ${service.name}: nessuna risposta su ${service.readyPath} entro il tempo massimo`);
    }
    lines.push(`servizio ${service.name} pronto`);
  }
  return done(true);
}
