import { describe, expect, it } from "vitest";
import { validateCuratedSources } from "./curated-sources";

const ok = { url: "https://example.com/guida", label: "Guida" };

describe("validateCuratedSources", () => {
  it("accetta un elenco valido o vuoto", () => {
    expect(validateCuratedSources([])).toBeNull();
    expect(validateCuratedSources([ok, { url: "https://example.org", label: "Altra" }])).toBeNull();
  });
  it("rifiuta indirizzi non https o non validi", () => {
    expect(validateCuratedSources([{ url: "http://example.com", label: "A" }])).toMatch(/https/);
    expect(validateCuratedSources([{ url: "non un indirizzo", label: "A" }])).toMatch(/https/);
    expect(validateCuratedSources([{ url: "https://u:p@example.com", label: "A" }])).toMatch(/credenziali/);
  });
  it("controlla l'etichetta (1..80, una riga)", () => {
    expect(validateCuratedSources([{ url: ok.url, label: "  " }])).toMatch(/etichetta/);
    expect(validateCuratedSources([{ url: ok.url, label: "x".repeat(81) }])).toMatch(/etichetta/);
    expect(validateCuratedSources([{ url: ok.url, label: "a\nb" }])).toMatch(/etichetta/);
    expect(validateCuratedSources([{ url: ok.url, label: "x".repeat(80) }])).toBeNull();
  });
  it("rifiuta più di 30 fonti e le ripetizioni", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ url: `https://example.com/${i}`, label: "A" }));
    expect(validateCuratedSources(many)).toMatch(/30/);
    expect(validateCuratedSources(many.slice(0, 30))).toBeNull();
    expect(validateCuratedSources([ok, { ...ok, label: "Bis" }])).toMatch(/ripetut/);
  });
});
