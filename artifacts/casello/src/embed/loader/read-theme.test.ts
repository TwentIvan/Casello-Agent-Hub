import { describe, expect, it } from "vitest";
import { readHostTheme } from "./read-theme";

function fakeRoot(classes: string[], attrs: Record<string, string> = {}) {
  return {
    classList: { contains: (c: string) => classes.includes(c) },
    getAttribute: (n: string) => attrs[n] ?? null,
  };
}
const style = (props: Record<string, string>) => () => ({
  getPropertyValue: (n: string) => props[n] ?? "",
});

describe("readHostTheme", () => {
  it("legge modalità scura e variabili", () => {
    const t = readHostTheme(fakeRoot(["dark"]), style({ "--primary": " 213 100% 47% " }), []);
    expect(t).toEqual({ mode: "dark", vars: { primary: "213 100% 47%" } });
  });

  it("data-theme e color-scheme dark", () => {
    expect(readHostTheme(fakeRoot([], { "data-theme": "dark" }), style({}), []).mode).toBe("dark");
    expect(readHostTheme(fakeRoot([]), style({ "color-scheme": "dark" }), []).mode).toBe("dark");
    expect(readHostTheme(fakeRoot([]), style({}), []).mode).toBe("light");
  });

  it("scarta valori non ammessi", () => {
    const t = readHostTheme(fakeRoot([]), style({ "--primary": "url(x)" }), []);
    expect(t.vars).toEqual({});
  });

  it("prende il primo link di Google Fonts", () => {
    const t = readHostTheme(fakeRoot([]), style({}), [
      "https://example.com/a.css",
      "https://fonts.googleapis.com/css2?family=Roboto",
    ]);
    expect(t.fontUrl).toBe("https://fonts.googleapis.com/css2?family=Roboto");
  });
});
