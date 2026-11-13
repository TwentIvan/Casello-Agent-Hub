import { describe, expect, it } from "vitest";
import { describeStep } from "./describe";

describe("describeStep", () => {
  it("leggi_file con e senza righe", () => {
    expect(describeStep("leggi_file", '{"percorso":"server/routes.ts","daRiga":10,"aRiga":40}')).toBe(
      "Legge server/routes.ts, righe 10–40",
    );
    expect(describeStep("leggi_file", '{"percorso":"a.ts","daRiga":"3"}')).toBe("Legge a.ts");
    expect(describeStep("leggi_file", '{"percorso":42}')).toBe("Legge un file");
    expect(describeStep("leggi_file", "non json")).toBe("Legge un file");
  });

  it("elenca_cartella", () => {
    expect(describeStep("elenca_cartella", '{"percorso":""}')).toBe("Guarda la radice del codice");
    expect(describeStep("elenca_cartella", '{"percorso":"src"}')).toBe("Guarda la cartella src");
    expect(describeStep("elenca_cartella", "{}")).toBe("Guarda una cartella");
  });

  it("cerca_nel_codice", () => {
    expect(describeStep("cerca_nel_codice", '{"testo":"registerRoutes","glob":"src/**"}')).toBe(
      'Cerca "registerRoutes" nel codice in src/**',
    );
    expect(describeStep("cerca_nel_codice", '{"testo":"x"}')).toBe('Cerca "x" nel codice');
    expect(describeStep("cerca_nel_codice", "{}")).toBe("Cerca nel codice");
    const text = describeStep("cerca_nel_codice", JSON.stringify({ testo: "a\nb\u0007" + "x".repeat(500) }));
    expect(text).not.toMatch(/[\n\u0000-\u001f]/);
    const field = text.slice('Cerca "'.length, text.indexOf('" nel codice'));
    expect(field.length).toBeLessThanOrEqual(81);
  });

  it("strumenti di lettura", () => {
    expect(describeStep("read_item", '{"ref":"e3"}')).toBe("Rilegge la voce e3 del piano");
    expect(describeStep("read_item", "{}")).toBe("Rilegge una voce del piano");
    expect(describeStep("read_app", '{"slug":"hubup"}')).toBe("Legge l'app hubup");
    expect(describeStep("read_app", "{}")).toBe("Legge un'app");
    expect(describeStep("propose", "{}")).toBe("Prepara una scheda");
    expect(describeStep("leggi_squadra", "{}")).toBe("Legge la squadra");
    expect(describeStep("leggi_skill", '{"code":"ruolo-qa"}')).toBe("Legge la skill ruolo-qa");
    expect(describeStep("leggi_versione_skill", '{"code":"ruolo-qa","version":2}')).toBe("Legge la skill ruolo-qa");
    expect(describeStep("leggi_skill", "{}")).toBe("Legge una skill");
    expect(describeStep("leggi_strumento", "{}")).toBe("Legge gli strumenti dell'app");
    expect(describeStep("leggi_strumenti_app", "{}")).toBe("Legge gli strumenti dell'app");
    expect(describeStep("leggi_agente", "{}")).toBe("Legge l'agente");
    expect(describeStep("leggi_modello", "{}")).toBe("Legge il modello di squadra");
    expect(describeStep("elenca_agenti", "{}")).toBe("Scorre gli agenti");
    expect(describeStep("elenca_skill", "{}")).toBe("Scorre le skill");
    expect(describeStep("elenca_modelli", "{}")).toBe("Scorre i modelli di squadra");
  });

  it("schede, memoria e centralino", () => {
    expect(describeStep("proponi_nuovo_agente", "{}")).toBe("Prepara una scheda");
    expect(describeStep("passa_a", "{}")).toBe("Prepara il passaggio di consegne");
    expect(describeStep("ricorda", '{"testo":"x"}')).toBe("Prende un appunto");
    expect(describeStep("aggiorna_appunto", "{}")).toBe("Prende un appunto");
    expect(describeStep("dimentica", "{}")).toBe("Toglie un appunto");
    expect(describeStep("cerca_nello_storico", "{}")).toBe("Cerca negli incontri passati");
    expect(describeStep("squadre_stato", "{}")).toBe("Controlla le squadre");
    expect(describeStep("squadra_dettaglio", "{}")).toBe("Legge il dettaglio di una squadra");
    expect(describeStep("bollettino", "{}")).toBe("Legge il bollettino");
    expect(describeStep("coda_da_confermare", "{}")).toBe("Guarda la coda da confermare");
    expect(describeStep("leggi_proposta", '{"numero":12}')).toBe("Legge la proposta n. 12");
    expect(describeStep("leggi_proposta", '{"numero":"12"}')).toBe("Legge una proposta");
    expect(describeStep("scrivi_al_capo", '{"testo":"segreto"}')).toBe("Scrive al capo della squadra");
    expect(describeStep("elenca_app", "{}")).toBe("Scorre le app");
    expect(describeStep("chiedi_al_responsabile", '{"app":"hubup","richiesta":"segreto"}')).toBe(
      "Chiede al Responsabile di hubup",
    );
    expect(describeStep("chiedi_al_responsabile", "{}")).toBe("Chiede al Responsabile di prodotto");
    expect(describeStep("leggi_run", "{}")).toBe("Legge l'esito di una run");
  });

  it("non rivela contenuti e ha un ripiego", () => {
    expect(describeStep("scrivi_al_capo", '{"testo":"segreto"}')).not.toContain("segreto");
    expect(describeStep("ricorda", '{"testo":"x"}')).not.toContain("x ");
    expect(describeStep("boh", "{}")).toBe("Usa uno strumento");
  });
});

describe("describeStep leggi_pagina_web", () => {
  it("usa solo l'host in minuscolo", () => {
    expect(describeStep("leggi_pagina_web", '{"url":"https://Herdr.dev/blog?token=abc"}')).toBe("Legge la pagina herdr.dev");
  });
  it("url non valido o mancante", () => {
    expect(describeStep("leggi_pagina_web", '{"url":"non valido"}')).toBe("Legge una pagina web");
    expect(describeStep("leggi_pagina_web", "{}")).toBe("Legge una pagina web");
  });
  it("host lungo tagliato a 80", () => {
    const host = `${"a".repeat(60)}.${"b".repeat(39)}`;
    expect(describeStep("leggi_pagina_web", JSON.stringify({ url: `https://${host}/` }))).toBe(`Legge la pagina ${host.slice(0, 80)}…`);
  });
});
