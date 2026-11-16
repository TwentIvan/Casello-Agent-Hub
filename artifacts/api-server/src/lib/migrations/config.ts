// Configurazione dell'esecutore delle migrazioni all'avvio (vedi la spec delle migrazioni automatiche).
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger";

/** Cartella dei file SQL: `MIGRATIONS_DIR`, in produzione `/app/migrations`, altrimenti `docs/migrations` del repository. */
export function migrationsDir(): string {
  const fromEnv = process.env["MIGRATIONS_DIR"];
  if (fromEnv) return fromEnv;
  if (process.env["NODE_ENV"] === "production") return "/app/migrations";
  // Il codice gira sia da src/lib/migrations (vitest, tsx) sia dal bundle dist/index.mjs: si risale finché si trova la cartella.
  let current = dirname(fileURLToPath(import.meta.url));
  const root = parse(current).root;
  for (;;) {
    const candidate = join(current, "docs", "migrations");
    if (existsSync(candidate)) return candidate;
    if (current === root) break;
    current = dirname(current);
  }
  throw new Error("cartella docs/migrations non trovata: imposta MIGRATIONS_DIR");
}

/** `MIGRATIONS_DISABLED=true` salta l'esecutore, solo fuori produzione (in produzione è ignorata con un avviso). */
export function migrationsDisabled(): boolean {
  if (process.env["MIGRATIONS_DISABLED"] !== "true") return false;
  if (process.env["NODE_ENV"] === "production") {
    logger.warn("MIGRATIONS_DISABLED ignorata in produzione: le migrazioni si applicano comunque");
    return false;
  }
  return true;
}
