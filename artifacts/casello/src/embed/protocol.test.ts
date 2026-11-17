import { describe, expect, it } from "vitest";
import { contextMessage, parseFromFrame, parseToFrame } from "./protocol";

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
  const status = { pending: 2, bugs: 1, working: true, unread: false, actions: 3 };

  it("accetta status valido e scarta i campi in più", () => {
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { ...status, extra: "x" }, y: 1 })).toEqual({
      botcave: 1,
      type: "status",
      payload: status,
    });
  });

  it("rifiuta status con numeri o booleani sbagliati", () => {
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { ...status, pending: -1 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { ...status, bugs: 1.5 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { ...status, working: "sì" } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { ...status, unread: 1 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { ...status, actions: 7 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "status", payload: { pending: 1 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "status" })).toBeNull();
  });

  it("badge (iframe di prima) diventa status", () => {
    expect(parseFromFrame({ botcave: 1, type: "badge", payload: { pending: 3 } })).toEqual({
      botcave: 1,
      type: "status",
      payload: { pending: 3, bugs: 0, working: false, unread: false, actions: 0 },
    });
  });

  it("rifiuta un badge negativo o non intero", () => {
    expect(parseFromFrame({ botcave: 1, type: "badge", payload: { pending: -1 } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "badge", payload: { pending: 1.5 } })).toBeNull();
  });

  it("accetta i messaggi validi", () => {
    expect(parseFromFrame({ botcave: 1, type: "ready", x: 1 })).toEqual({ botcave: 1, type: "ready" });
    expect(parseFromFrame({ botcave: 1, type: "close" })).toEqual({ botcave: 1, type: "close" });
    expect(
      parseFromFrame({ botcave: 1, type: "error", payload: { code: "unreachable" } }),
    ).toEqual({ botcave: 1, type: "error", payload: { code: "unreachable" } });
    expect(parseFromFrame({ botcave: 1, type: "error", payload: { code: "boh" } })).toBeNull();
    expect(parseFromFrame({ botcave: 1, type: "nope" })).toBeNull();
  });
});

describe("open con la barra del contesto", () => {
  it("accetta focusContext true e scarta gli altri valori", () => {
    expect(parseToFrame({ botcave: 1, type: "open", payload: { focusContext: true } })).toEqual({
      botcave: 1,
      type: "open",
      payload: { focusContext: true },
    });
    expect(parseToFrame({ botcave: 1, type: "open", payload: { tab: "lead", focusContext: true } })).toEqual({
      botcave: 1,
      type: "open",
      payload: { tab: "lead", focusContext: true },
    });
    expect(parseToFrame({ botcave: 1, type: "open", payload: { focusContext: "sì" } })).toEqual({
      botcave: 1,
      type: "open",
      payload: {},
    });
  });
});

describe("contextMessage (Botcave.setContext del caricatore)", () => {
  it("contesto valido: messaggio context con i soli campi ammessi", () => {
    expect(contextMessage({ page: "workitem", id: "1174", title: "Fix ordini", extra: 1 })).toEqual({
      botcave: 1,
      type: "context",
      payload: { page: "workitem", id: "1174", title: "Fix ordini" },
    });
  });

  it("contesto non valido: null (il caricatore avvisa in console e non lo manda)", () => {
    expect(contextMessage(null)).toBeNull();
    expect(contextMessage({})).toBeNull();
    expect(contextMessage({ page: "con spazi" })).toBeNull();
    expect(contextMessage("workitem")).toBeNull();
  });
});

describe("identità e scheda bugs", () => {
  it("accetta identity con stringa o null e scarta il resto", () => {
    expect(parseToFrame({ botcave: 1, type: "identity", payload: { token: "a.b-c_d" } })).toEqual({
      botcave: 1,
      type: "identity",
      payload: { token: "a.b-c_d" },
    });
    expect(parseToFrame({ botcave: 1, type: "identity", payload: { token: null } })).toEqual({
      botcave: 1,
      type: "identity",
      payload: { token: null },
    });
    expect(parseToFrame({ botcave: 1, type: "identity", payload: { token: {} } })).toBeNull();
    expect(parseToFrame({ botcave: 1, type: "identity", payload: { token: "a b" } })).toBeNull();
    expect(parseToFrame({ botcave: 1, type: "identity", payload: { token: "a".repeat(4097) } })).toBeNull();
    expect(parseToFrame({ botcave: 1, type: "identity" })).toBeNull();
  });
  it("open accetta lead", () => {
    expect(parseToFrame({ botcave: 1, type: "open", payload: { tab: "lead" } })).toEqual({
      botcave: 1,
      type: "open",
      payload: { tab: "lead" },
    });
  });
  it("open accetta bugs", () => {
    expect(parseToFrame({ botcave: 1, type: "open", payload: { tab: "bugs" } })).toEqual({
      botcave: 1,
      type: "open",
      payload: { tab: "bugs" },
    });
  });
  it("parseFromFrame accetta identity_request", () => {
    expect(parseFromFrame({ botcave: 1, type: "identity_request", x: 1 })).toEqual({
      botcave: 1,
      type: "identity_request",
    });
  });
});
