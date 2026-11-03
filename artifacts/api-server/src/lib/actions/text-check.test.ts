import { describe, expect, it } from "vitest";
import { checkQueuedText } from "./text-check";

const ok = (summary: string, args: Record<string, unknown> = {}) =>
  checkQueuedText({ recipient: "Mario Rossi <mario@example.it>", summary, args });

describe("checkQueuedText: segnaposto", () => {
  it("trova le parentesi quadre con almeno una lettera", () => {
    expect(ok("Invio a [nome] il preventivo [data da concordare]")).toEqual([
      'segnaposto "[nome]"',
      'segnaposto "[data da concordare]"',
    ]);
  });

  it("non segnala parentesi vuote o senza lettere", () => {
    expect(ok("valori [] e [1] e [ 2024 ]")).toEqual([]);
  });

  it("trova il testo tra angolari che non è un tag HTML", () => {
    expect(ok("data <da definire>")).toEqual(['segnaposto "<da definire>"']);
  });

  it("non segnala i tag HTML", () => {
    expect(ok("<p>ciao<br></p><b>x</b> <a href=\"x\">link</a> <br/>")).toEqual([]);
  });

  it("trova TODO, TBD, XXX come parole intere e ??? come letterale", () => {
    expect(ok("TODO sistemare, TBD, XXX e ???")).toEqual([
      'segnaposto "TODO"',
      'segnaposto "TBD"',
      'segnaposto "XXX"',
      'segnaposto "???"',
    ]);
  });

  it("TODO è case-sensitive e va come parola intera", () => {
    expect(ok("todo minuscolo, TODOS, XXXL")).toEqual([]);
  });

  it("riporta ogni problema una sola volta, nell'ordine di apparizione", () => {
    expect(ok("TBD poi [nome] poi TBD")).toEqual(['segnaposto "TBD"', 'segnaposto "[nome]"']);
  });

  it("non riporta TODO dentro un segnaposto già segnalato", () => {
    expect(ok("[TODO]")).toEqual(['segnaposto "[TODO]"']);
  });
});

describe("checkQueuedText: menzioni", () => {
  it("non segnala una menzione se il destinatario contiene il nome (senza distinzione di maiuscole)", () => {
    expect(ok("grazie @MARIO")).toEqual([]);
  });

  it("segnala una menzione assente dal destinatario", () => {
    expect(ok("ciao @luca")).toEqual(['menzione "@luca" non nel destinatario']);
  });

  it("un'email non è una menzione", () => {
    expect(ok("scrivi a a@b.it")).toEqual([]);
  });

  it("la menzione vale in inizio stringa, dopo spazio o punteggiatura", () => {
    expect(ok("@luca, (@anna) e \"@paolo\"")).toEqual([
      'menzione "@luca" non nel destinatario',
      'menzione "@anna" non nel destinatario',
      'menzione "@paolo" non nel destinatario',
    ]);
  });

  it("non tiene il punto finale dentro il nome", () => {
    expect(ok("ciao @luca.")).toEqual(['menzione "@luca" non nel destinatario']);
  });
});

describe("checkQueuedText: testi annidati", () => {
  it("controlla i valori stringa di oggetti e array in args", () => {
    const problems = checkQueuedText({
      recipient: "Mario",
      summary: "ok",
      args: {
        body: "Testo con [nome]",
        to: ["mario@x.it", "@luca"],
        meta: { note: { deep: "XXX" } },
        count: 3,
        flag: true,
        empty: null,
      },
    });
    expect(problems).toEqual([
      'segnaposto "[nome]"',
      'menzione "@luca" non nel destinatario',
      'segnaposto "XXX"',
    ]);
  });

  it("senza problemi restituisce un elenco vuoto", () => {
    expect(
      checkQueuedText({ recipient: "Mario", summary: "Ciao Mario", args: { body: "Tutto a posto" } }),
    ).toEqual([]);
  });
});

describe("checkQueuedText: ordine di apparizione", () => {
  it("mescola segnaposto e menzioni nell'ordine in cui compaiono nel testo", () => {
    expect(ok("ciao @luca, poi [nome] e @anna")).toEqual([
      'menzione "@luca" non nel destinatario',
      'segnaposto "[nome]"',
      'menzione "@anna" non nel destinatario',
    ]);
  });
});

describe("checkQueuedText: segnaposto tra angolari", () => {
  it("segnala i segnaposto di una sola parola che non sono tag HTML", () => {
    expect(ok("Gentile <nome>, cliente <cliente>")).toEqual([
      'segnaposto "<nome>"',
      'segnaposto "<cliente>"',
    ]);
  });

  it("segnala anche la chiusura di un segnaposto", () => {
    expect(ok("fine </nome>")).toEqual(['segnaposto "</nome>"']);
  });

  it("non segnala i tag HTML reali, senza distinzione di maiuscole e con / finale", () => {
    expect(ok("<A HREF=\"x\">link</A> <BR> <br/> </p>")).toEqual([]);
  });
});
