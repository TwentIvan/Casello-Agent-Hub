import { describe, expect, it } from "vitest";
import { cleanThemeValue, themeToCss } from "./theme";

describe("cleanThemeValue", () => {
  it("accetta i colori nei formati ammessi", () => {
    for (const v of [
      "213 100% 47%",
      "#fff",
      "#0a84ffcc",
      "rgb(10 20 30)",
      "rgba(10, 20, 30, 0.5)",
      "hsl(213 100% 47% / 0.4)",
      "oklch(0.7 0.1 250)",
    ]) {
      expect(cleanThemeValue("primary", v)).toBe(v);
    }
  });

  it("rifiuta iniezioni e url", () => {
    expect(cleanThemeValue("primary", "red; background:url(x)")).toBeNull();
    expect(cleanThemeValue("primary", "url(https://x)")).toBeNull();
    expect(cleanThemeValue("background", "red")).toBeNull();
  });

  it("controlla raggio e font", () => {
    expect(cleanThemeValue("radius", "0.375rem")).toBe("0.375rem");
    expect(cleanThemeValue("radius", "1em")).toBeNull();
    expect(cleanThemeValue("font-sans", "Inter, 'Helvetica Neue', sans-serif")).toBe(
      "Inter, 'Helvetica Neue', sans-serif",
    );
    expect(cleanThemeValue("font-sans", "x;y:z")).toBeNull();
  });
});

describe("themeToCss", () => {
  it("traduce un colore shadcn nei token Botcave", () => {
    expect(themeToCss({ mode: "light", vars: { primary: "213 100% 47%" } })).toEqual({
      "--accent": "hsl(213 100% 47%)",
      "--accent-text": "hsl(213 100% 47%)",
    });
  });

  it("traduce le altre variabili e lascia invariati i colori espliciti", () => {
    expect(
      themeToCss({
        mode: "dark",
        vars: { background: "#101010", radius: "0.5rem", "font-sans": "Inter" },
      }),
    ).toEqual({ "--surface-1": "#101010", "--radius-md": "0.5rem", "--font-sans": "Inter" });
  });

  it("scarta valori non validi anche se passati direttamente", () => {
    expect(themeToCss({ mode: "light", vars: { border: "url(x)" } })).toEqual({});
  });
});
