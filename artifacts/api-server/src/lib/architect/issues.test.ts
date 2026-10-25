import { describe, expect, it } from "vitest";
import type { AnalysisItem } from "@workspace/db";
import { exportIssues, issueMarkdown } from "./issues";
import type { CompletionItem } from "./schemas";

const completion = (over: Partial<CompletionItem>): CompletionItem => ({
  key: "a",
  phase: 1,
  area: "Squadre",
  title: "Voce A",
  missing: "manca X",
  evidence: [{ source: "code", location: "src/a.ts:3" }],
  goal: "obiettivo",
  dependsOn: [],
  files: ["src/a.ts"],
  effort: "S",
  doneWhen: "fatto quando",
  implementation: "come",
  ...over,
});

let n = 0;
const row = (payload: unknown, chapter: AnalysisItem["chapter"] = "completion"): AnalysisItem => {
  n += 1;
  return {
    id: n,
    analysisId: 1,
    chapter,
    ref: `${chapter}:${n}`,
    position: n,
    payload,
    diff: "new",
    evidence: [],
    status: "approved",
    reviewNote: null,
    appliedAt: null,
    createdAt: new Date(),
  };
};

describe("issueMarkdown", () => {
  it("ha le quattro sezioni e un titolo su una riga senza intestazioni", () => {
    const { title, body } = issueMarkdown(row(completion({ title: "## Titolo\nsu più righe" })));
    expect(title).toBe("Titolo su più righe");
    for (const s of ["## Contesto", "## Da fare", "## Pronto quando", "## Prove"]) expect(body).toContain(s);
    expect(body).toContain("src/a.ts:3");
  });
});

describe("exportIssues", () => {
  it("completion: per fase, e b (dipende da a) dopo a", () => {
    const items = [
      row(completion({ key: "c", title: "Voce C", phase: 2 })),
      row(completion({ key: "b", title: "Voce B", dependsOn: ["a"] })),
      row(completion({ key: "a", title: "Voce A" })),
    ];
    const { markdown, count } = exportIssues(items, "completion");
    expect(count).toBe(3);
    expect(markdown.indexOf("Voce A")).toBeLessThan(markdown.indexOf("### Voce B"));
    expect(markdown.indexOf("## Fase 1")).toBeLessThan(markdown.indexOf("## Fase 2"));
    expect(markdown.indexOf("### Voce B")).toBeLessThan(markdown.indexOf("## Fase 2"));
    expect(markdown).toContain("Dipende da: Voce A");
  });

  it("dipendenze cicliche o ignote non fanno girare all'infinito", () => {
    const items = [
      row(completion({ key: "a", dependsOn: ["b"] })),
      row(completion({ key: "b", title: "Voce B", dependsOn: ["a", "zzz"] })),
    ];
    expect(exportIssues(items, "completion").count).toBe(2);
  });

  it("filtra per capitolo e gestisce il vuoto", () => {
    expect(exportIssues([row(completion({}))], "evolution")).toEqual({ markdown: "", count: 0 });
  });
});
