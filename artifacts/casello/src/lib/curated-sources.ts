export interface CuratedSourceRow {
  url: string;
  label: string;
}

export const MAX_CURATED_SOURCES = 30;

/** Stesse regole del server (fonti curate di Lucius): messaggio sul primo problema, null se va bene. */
export function validateCuratedSources(rows: CuratedSourceRow[]): string | null {
  if (rows.length > MAX_CURATED_SOURCES) return `Al più ${MAX_CURATED_SOURCES} fonti.`;
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const n = i + 1;
    const url = row.url.trim();
    const label = row.label.trim();
    if (label.length < 1 || label.length > 80 || /[\r\n]/.test(label)) {
      return `Fonte ${n}: l'etichetta deve avere da 1 a 80 caratteri su una riga.`;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Fonte ${n}: serve un indirizzo https valido.`;
    }
    if (url.length > 2000 || parsed.protocol !== "https:") return `Fonte ${n}: serve un indirizzo https valido.`;
    if (parsed.username || parsed.password) return `Fonte ${n}: l'indirizzo non può contenere credenziali.`;
    if (seen.has(url)) return `Fonte ${n}: indirizzo ripetuto.`;
    seen.add(url);
  }
  return null;
}
