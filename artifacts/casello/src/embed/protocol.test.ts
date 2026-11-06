import { describe, expect, it } from "vitest";
import { parseFromFrame, parseToFrame } from "./protocol";

describe("parseToFrame", () => {
  it("scarta i campi in più del contesto", () => {
    const m = parseToFrame({
      botcave: 1,
      type: "context",
      payload: { page: "workitem", id: "1174", title: "Fix", x: 1 },
    });
    expect(m).toEqual({
      botcave: 1,
      type: "context",
      payload: { page: "workitem", id: "1174", title: "Fix" },
    });
  });

  it("rifiuta una pagina di 41 caratteri", () => {
    expect(
      parseToFrame({ botcave: 1, type: "context", payload: { page: "a".repeat(41) } }),
    ).toBeNull();
  });

  it("rifiuta titoli su più righe o troppo lunghi", () => {
    expect(
      parseToFrame({ botcave: 1, type: "context", payload: { page: "p", title: "a\nb" } }),
    ).toBeNull();
    expect(
      parseToFrame({ botcave: 1, type: "context", payload: { page: "p", title: "a".repeat(201) } }),
    ).toBeNull();
  });

  it("rifiuta versione o tipo sconosciuti", () => {
    expect(parseToFrame({ botcave: 2, type: "open", payload: {} })).toBeNull();
    expect(parseToFrame({ botcave: 1, type: "eval", payload: {} })).toBeNull();
    expect(parseToFrame(null)).toBeNull();
    expect(parseToFrame("x")).toBeNull();
  });

  it("accetta open con scheda valida e rifiuta quella sconosciuta", () => {
    expect(parseToFrame({ botcave: 1, type: "open", payload: { tab: "lucius" } })).toEqual({
      botcave: 1,
      type: "open",
      payload: { tab: "lucius" },
    });
    expect(parseToFrame({ botcave: 1, type: "open", payload: { tab: "x" } })).toBeNull();
    expect(parseToFrame({ botcave: 1, type: "open" })).toEqual({
      botcave: 1,
      type: "open",
      payload: {},
    });
  });

  it("filtra le variabili del tema e scarta fontUrl non ammesso", () => {
    const m = parseToFrame({
      botcave: 1,
      type: "theme",
      payload: {
        mode: "dark",
        vars: { primary: "213 100% 47%", border: "url(https://x)", evil: "1" },
        fontUrl: "https://evil.example/x.css",
      },
    });
    expect(m).toEqual({
      botcave: 1,
      type: "theme",
      payload: { mode: "dark", vars: { primary: "213 100% 47%" } },
    });
  });
});

describe("parseFromFrame", () => {
  it("rifiuta un badge negativo o non intero", () => {
    expect(parseFromFrame({ botcave: 1, type: "badge", payload: { pending: -1 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "badge", payload: { pending: 1.5 } })).toBeNull();
  });

  it("accetta i messaggi validi", () => {
    expect(parseFromFrame({ botcave: 1, type: "ready", x: 1 })).toEqual({ botcave: 1, type: "ready" });
    expect(parseFromFrame({ botcave: 1, type: "close" })).toEqual({ botcave: 1, type: "close" });
    expect(parseFromFrame({ botcave: 1, type: "badge", payload: { pending: 3 } })).toEqual({
      botcave: 1,
      type: "badge",
      payload: { pending: 3 },
    });
    expect(
      parseFromFrame({ botcave: 1, type: "error", payload: { code: "unreachable" } }),
    ).toEqual({ botcave: 1, type: "error", payload: { code: "unreachable" } });
    expect(parseFromFrame({ botcave: 1, type: "error", payload: { code: "boh" } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "nope" })).toBeNull();
  });
});
