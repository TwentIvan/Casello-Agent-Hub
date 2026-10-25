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
