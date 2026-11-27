import { describe, expect, it } from "vitest";
import { validateRecipe } from "./recipe";

function validRecipe(overrides: Record<string, unknown> = {}) {
  return {
    install: ["corepack pnpm install"],
    build: ["corepack pnpm run build"],
    services: [{ name: "api", command: "node dist/index.js", port: 3000, readyPath: "/api/healthz" }],
    postgres: true,
    schema: ["corepack pnpm run db:push"],
    env: { NODE_ENV: "test", LOG_LEVEL: "warn" },
    startUrl: "/",
    login: null,
    ...overrides,
  };
}

describe("validateRecipe", () => {
  it("accetta una ricetta valida", () => {
    const result = validateRecipe(validRecipe());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recipe.services[0]?.port).toBe(3000);
  });

  it("rifiuta un comando su più righe", () => {
    const result = validateRecipe(validRecipe({ build: ["pnpm run build\nrm -rf x"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("una riga");
  });

  it("rifiuta più di 20 passi", () => {
    const install = Array.from({ length: 21 }, (_, i) => `echo ${i}`);
    const result = validateRecipe(validRecipe({ install }));
    expect(result.ok).toBe(false);
  });

  it("rifiuta una variabile d'ambiente che sembra una chiave", () => {
    const key = `sk-${"a".repeat(40)}`;
    const result = validateRecipe(validRecipe({ env: { OPENAI_API_KEY: key } }));
    expect(result.ok).toBe(false);
  });

  it("rifiuta una porta 0", () => {
    const services = [{ name: "api", command: "node x.js", port: 0, readyPath: "/" }];
    const result = validateRecipe(validRecipe({ services }));
    expect(result.ok).toBe(false);
  });

  it("rifiuta un startUrl che non comincia con /", () => {
    const result = validateRecipe(validRecipe({ startUrl: "https://example.com" }));
    expect(result.ok).toBe(false);
  });

  it("rifiuta un comando che sembra contenere una credenziale", () => {
    const token = `ghp_${"b".repeat(40)}`;
    const result = validateRecipe(validRecipe({ install: [`echo ${token}`] }));
    expect(result.ok).toBe(false);
  });

  it("rifiuta una chiave d'ambiente non valida", () => {
    const result = validateRecipe(validRecipe({ env: { "bad-key": "x" } }));
    expect(result.ok).toBe(false);
  });

  it("rifiuta una ricetta che non è un oggetto", () => {
    expect(validateRecipe("nope").ok).toBe(false);
    expect(validateRecipe(null).ok).toBe(false);
  });
});
