import { describe, expect, it } from "vitest";
import type { AnalysisItem } from "@workspace/db";
import { exportAll, exportChapter, exportIssues, issueMarkdown } from "./issues";
import type { CompletionItem, EvolutionItem } from "./schemas";

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
    origin: "architect",
    conversationId: null,
    issueRepo: null,
    issueNumber: null,
    issueUrl: null,
    issueState: null,
    issueStateReason: null,
    issueCreatedAt: null,
    issueCheckedAt: null,
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
    expect(markdown.indexOf("### Voce A")).toBeLessThan(markdown.indexOf("### Voce B"));
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

  it("evolution: per area, poi per priorità (1 = massima) e posizione", () => {
    const evo = (over: Partial<EvolutionItem>): EvolutionItem => ({
      area: "Squadre",
      type: "funzione",
      title: "t",
      motivation: "m",
      evidence: [],
      benefit: "b",
      impact: "medio",
      effort: "S",
      priority: 3,
      implementation: "i",
      ...over,
    });
    const items = [
      row(evo({ title: "S3 prima", priority: 3 }), "evolution"),
      row(evo({ title: "Mercato 2", area: "Mercato", priority: 2 }), "evolution"),
      row(evo({ title: "S1", priority: 1 }), "evolution"),
      row(evo({ title: "S3 dopo", area: " Squadre ", priority: 3 }), "evolution"),
    ];
    const { markdown, count } = exportIssues(items, "evolution");
    expect(count).toBe(4);
    const at = (s: string) => markdown.indexOf(s);
    expect(markdown.match(/^## /gm)).toHaveLength(2);
    expect(at("## Squadre")).toBeLessThan(at("### S1"));
    expect(at("### S1")).toBeLessThan(at("### S3 prima"));
    expect(at("### S3 prima")).toBeLessThan(at("### S3 dopo"));
    expect(at("### S3 dopo")).toBeLessThan(at("## Mercato"));
    expect(at("## Mercato")).toBeLessThan(at("### Mercato 2"));
    expect(markdown).toContain("#### Contesto");
  });

  it("filtra per capitolo e gestisce il vuoto", () => {
    expect(exportIssues([row(completion({}))], "evolution")).toEqual({ markdown: "", count: 0 });
  });
});

describe("sicurezza del markdown", () => {
  it("il patch sta in un blocco recintato più lungo dei suoi apici e # a inizio riga è neutralizzato", () => {
    const patch = "codice\n```js\nx\n```";
    const endpoint = row(
      { title: "t", area: "A", method: "get", path: "/x", motivation: "ok\n# Intruso", patch, evidence: [] },
      "endpoint",
    );
    const { body } = issueMarkdown(endpoint);
    expect(body).toContain("````\ncodice");
    expect(body).toContain("\\# Intruso");
    expect(body).not.toMatch(/^# Intruso/m);
  });

  it("i file su più righe restano su una riga", () => {
    const { body } = issueMarkdown(row(completion({ files: ["a.ts\n## Intruso"] })));
    expect(body).toContain("- a.ts ## Intruso");
  });
});

describe("esportazione compatta e completa", () => {
  const ev = [{ source: "code" as const, location: "src/t.ts:1" }];
  const tool = {
    name: "get_x",
    description: "Legge X",
    kind: "http",
    identity: "service",
    requiresConfirmation: true,
    readOnly: false,
    paramsSchema: { type: "object", properties: {} },
    definition: { method: "POST", path: "/x", paramLocations: {} },
    area: "A",
    evidence: ev,
    needsVerification: true,
  };
  const agent = {
    role: "area",
    area: "Squadre",
    name: "Agente squadre",
    systemPrompt: "p".repeat(400),
    defaultIdentity: "user",
    toolNames: ["get_x"],
  };

  it("tool: nome, chiamata, flag e prove", () => {
    const { markdown, count } = exportChapter([row(tool, "tool")], "tool");
    expect(count).toBe(1);
    expect(markdown).toContain("## get_x");
    expect(markdown).toContain("- Chiamata: POST /x");
    expect(markdown).toContain("- Richiede conferma: sì");
    expect(markdown).toContain("- Da verificare: sì");
    expect(markdown).toContain("- code: src/t.ts:1");
  });

  it("agente: ruolo, area, tool e prompt troncato a 300 caratteri", () => {
    const { markdown } = exportChapter([row(agent, "agent")], "agent");
    expect(markdown).toContain("- Ruolo: area, area Squadre");
    expect(markdown).toContain("- Tool: get_x");
    expect(markdown).toContain(`${"p".repeat(300)}…`);
    expect(markdown).not.toContain("p".repeat(301));
  });

  it("voce da rimuovere marcata", () => {
    const r = { ...row(tool, "tool"), diff: "removed" as const };
    expect(exportChapter([r], "tool").markdown).toContain("## get_x (da rimuovere)");
  });

  it("tutta l'analisi: capitoli nell'ordine, titoli # e per capitolo invariato", () => {
    const items = [row(completion({}), "completion"), row(tool, "tool")];
    const order = ["tool", "agent", "skill", "endpoint", "completion", "evolution"] as const;
    const { markdown, count } = exportAll(items, [...order]);
    expect(count).toBe(2);
    expect(markdown.indexOf("# Tool")).toBeLessThan(markdown.indexOf("# Completamento"));
    expect(markdown).toContain(`# Completamento\n\n${exportIssues(items, "completion").markdown}`);
    expect(exportAll([], [...order])).toEqual({ markdown: "", count: 0 });
  });
});
