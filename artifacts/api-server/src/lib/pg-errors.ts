/**
 * Violazione di un vincolo di unicità di Postgres (codice 23505), eventualmente di un vincolo
 * preciso. drizzle avvolge l'errore del driver in `cause`: si risale la catena.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4 && current; i++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23505") return constraint === undefined || e.constraint === constraint;
    current = e.cause;
  }
  return false;
}

/** Violazione di una chiave esterna (23503), eventualmente di un vincolo preciso, anche dentro `cause`. */
export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4 && current; i++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23503") return constraint === undefined || e.constraint === constraint;
    current = e.cause;
  }
  return false;
}
