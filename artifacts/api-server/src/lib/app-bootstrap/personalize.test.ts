import { describe, expect, it } from "vitest";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";
import { personalizeFiles } from "./personalize";

const vars = { slug: "portfolio", name: "Portfolio", domain: "portfolio.example.com", brief: "usa __SLUG__" };

describe("personalizeFiles", () => {
  it("sostituisce, sposta, salta .github, scrive brief e marcatore", () => {
    const files = new Map([
      ["artifacts/__SLUG__-web/index.html", 'data-app="__SLUG__"'],
      [".github/workflows/deploy.yml", "__SLUG__"],
      [".botcave/modello.json", '{"template":"botcave-modello-app","version":1}'],
      ["README.md", "uguale"],
    ]);
    const r = personalizeFiles(files, vars);
    if ("error" in r) throw new Error(r.error);
    expect(r.changes.get("artifacts/portfolio-web/index.html")).toBe('data-app="portfolio"');
    expect(r.changes.get("artifacts/__SLUG__-web/index.html")).toBeNull();
    expect(r.changes.has(".github/workflows/deploy.yml")).toBe(false);
    expect(r.changes.has("README.md")).toBe(false);
    expect(r.changes.get("AGENT_BRIEF.md")).toBe("usa __SLUG__");
    expect(JSON.parse(r.changes.get(".botcave/modello.json") as string)).toEqual({
      template: "botcave-modello-app",
      version: 1,
      slug: "portfolio",
    });
  });
  it("più di 200 file è un errore", () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 201; i++) files.set(`f${i}`, "x");
    expect(personalizeFiles(files, vars)).toEqual({ error: M.tooManyFiles });
  });
});
