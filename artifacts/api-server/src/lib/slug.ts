import { isUniqueViolation } from "./pg-errors";

// Slug delle app: stessa regola della migrazione (docs/migrations/2026-10-fase-1.sql).
// Minuscolo, ogni sequenza di caratteri non alfanumerici diventa '-', trattini ai bordi tolti;
// se il risultato è vuoto si usa 'app'. Se lo slug è già preso si aggiunge '-<id>' finché non è libero.

export function slugBase(name: string): string {
  const slug = name
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

export async function uniqueSlug(
  name: string,
  id: number,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let candidate = slugBase(name);
  while (await exists(candidate)) candidate = `${candidate}-${id}`;
  return candidate;
}

const SLUG_ATTEMPTS = 3;

/**
 * Esegue `create` riprovando (fino a 3 volte in tutto) se fallisce per la unique dello slug:
 * due creazioni concorrenti con lo stesso nome possono scegliere lo stesso slug libero.
 * `create` deve essere una transazione completa, ripetibile da capo.
 */
export async function withSlugRetry<T>(create: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await create();
    } catch (err) {
      if (attempt >= SLUG_ATTEMPTS || !isUniqueViolation(err, "apps_slug_unique")) throw err;
    }
  }
}
