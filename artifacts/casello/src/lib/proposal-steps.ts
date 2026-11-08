/**
 * Passi di una proposta saltati a catena: un passo non escluso che usa il risultato di un passo escluso (o a sua volta
 * saltato) non può partire. Stessa regola di `planExclusion` dell'API (`lib/actions/proposal.ts`).
 */
export function dependentsOf(steps: { key: string; refs: { step: string }[] }[], excluded: Set<string>): Set<string> {
  const skipped = new Set<string>();
  for (const s of steps) {
    if (excluded.has(s.key)) continue;
    if (s.refs.some((r) => excluded.has(r.step) || skipped.has(r.step))) skipped.add(s.key);
  }
  return skipped;
}
