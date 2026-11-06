import { describe, expect, it } from "vitest";
import { alfredPageContext, badgeIntervalMs, consoleUrl, findAppBySlug, isPanelOpen, nextBadge } from "./panel-helpers";

describe("alfredPageContext", () => {
  it("senza contesto della pagina ospite: console", () => {
    expect(alfredPageContext("hubup", null)).toEqual({ page: "console" });
  });
  it("con contesto: pagina host con l'app e i campi presenti", () => {
    expect(alfredPageContext("hubup", { page: "workitem", id: "1174", title: "WI 1174" })).toEqual({
      page: "host",
      host: { app: "hubup", page: "workitem", id: "1174", title: "WI 1174" },
    });
    expect(alfredPageContext("hubup", { page: "home" })).toEqual({ page: "host", host: { app: "hubup", page: "home" } });
  });
  it("slug non accettato dal server (vuoto o oltre 64 caratteri): console", () => {
    expect(alfredPageContext("", { page: "home" })).toEqual({ page: "console" });
    expect(alfredPageContext("a".repeat(65), { page: "home" })).toEqual({ page: "console" });
    expect(alfredPageContext("a".repeat(64), { page: "home" })).toEqual({ page: "host", host: { app: "a".repeat(64), page: "home" } });
  });
});

describe("findAppBySlug", () => {
  const apps = [
    { id: 1, slug: "mister" },
    { id: 2, slug: "hubup" },
  ];
  it("trova l'app con lo slug esatto", () => {
    expect(findAppBySlug(apps, "hubup")?.id).toBe(2);
  });
  it("nessuna corrispondenza, slug vuoto o elenco mancante: null", () => {
    expect(findAppBySlug(apps, "HUBUP")).toBeNull();
    expect(findAppBySlug(apps, "")).toBeNull();
    expect(findAppBySlug(undefined, "hubup")).toBeNull();
  });
});

describe("isPanelOpen e badgeIntervalMs", () => {
  it("aperto solo con documento visibile e pannello mostrato", () => {
    expect(isPanelOpen({ visible: true, shown: true })).toBe(true);
    expect(isPanelOpen({ visible: true, shown: false })).toBe(false);
    expect(isPanelOpen({ visible: false, shown: true })).toBe(false);
    expect(isPanelOpen({ visible: false, shown: false })).toBe(false);
  });
  it("5 s a pannello aperto, 30 s altrimenti", () => {
    expect(badgeIntervalMs(true)).toBe(5_000);
    expect(badgeIntervalMs(false)).toBe(30_000);
  });
});

describe("nextBadge", () => {
  it("si manda solo quando il conteggio cambia", () => {
    expect(nextBadge(null, 0)).toBe(0);
    expect(nextBadge(0, 0)).toBeNull();
    expect(nextBadge(0, 3)).toBe(3);
    expect(nextBadge(3, 3)).toBeNull();
  });
  it("conteggi non validi non si mandano", () => {
    expect(nextBadge(null, -1)).toBeNull();
    expect(nextBadge(null, 1.5)).toBeNull();
    expect(nextBadge(null, Number.NaN)).toBeNull();
  });
});

describe("consoleUrl", () => {
  it("unisce l'origine di Botcave e il percorso", () => {
    expect(consoleUrl("https://casello.fantamister.cloud", "/pending-actions")).toBe(
      "https://casello.fantamister.cloud/pending-actions",
    );
    expect(consoleUrl("https://casello.fantamister.cloud", "/teams/12")).toBe("https://casello.fantamister.cloud/teams/12");
  });
});
