import { describe, expect, it } from "vitest";
import type { AnalysisItem } from "@workspace/db";
import { creationOrder, isEligible, issueContent, issueLabels } from "./content";

let n = 0;
const row = (chapter: AnalysisItem["chapter"], payload: unknown, over: Partial<AnalysisItem> = {}): AnalysisItem => {
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
    ...over,
  };
};

const comp = (key: string, over: Record<string, unknown> = {}) =>
  row("completion", {
    key,
    phase: 1,
    area: "Squadre",
    title: `Titolo ${key}`,
    missing: "manca",
    evidence: [],
    goal: "obiettivo",
    dependsOn: [],
    files: [],
    effort: "S",
    doneWhen: "fatto",
    implementation: "come",
    ...over,
  });

const evo = (over: Record<string, unknown> = {}) =>
  row("evolution", {
    area: "Rosa",
    title: "Evo",
    type: "feature",
    impact: "high",
    effort: "M",
    priority: 1,
    motivation: "perché",
    implementation: "come",
    benefit: "beneficio",
    evidence: [],
    ...over,
  });

describe("isEligible", () => {
  it("ammette solo voci approvate dei tre capitoli", () => {
    expect(isEligible(comp("a"))).toBe(true);
    expect(isEligible(evo())).toBe(true);
    expect(isEligible(row("endpoint", {}))).toBe(true);
    expect(isEligible(row("completion", {}, { status: "pending" }))).toBe(false);
    expect(isEligible(row("tool", {}))).toBe(false);
    expect(isEligible(row("agent", {}))).toBe(false);
    expect(isEligible(row("skill", {}))).toBe(false);
  });
});

describe("creationOrder", () => {
  it("ordine: dipendenze prima, poi le altre nell'ordine dato", () => {
    const e = evo();
    const b = comp("b", { dependsOn: ["a"] });
    const a = comp("a");
    const late = comp("c", { phase: 2 });
    const ep = row("endpoint", {});
    expect(creationOrder([e, late, b, ep, a])).toEqual([a, b, late, e, ep]);
  });
});

describe("issueLabels", () => {
  it("etichette: casello + capitolo + fase-2 / P1", () => {
    expect(issueLabels(comp("a", { phase: 2 }))).toEqual(["casello", "completamento", "fase-2"]);
    expect(issueLabels(evo({ priority: 1 }))).toEqual(["casello", "evoluzione", "P1"]);
    expect(issueLabels(row("endpoint", {}))).toEqual(["casello", "endpoint"]);
  });
  it("evoluzione senza priorità: nessuna P", () => {
    expect(issueLabels(evo({ priority: undefined }))).toEqual(["casello", "evoluzione"]);
    expect(issueLabels(evo({ priority: 7 }))).toEqual(["casello", "evoluzione"]);
  });
});

describe("issueContent", () => {
  it("dipendenza con issue nota → #12 nel corpo, altrimenti il titolo", () => {
    const item = comp("b", { dependsOn: ["a", "z"] });
    const ctx = {
      appName: "Mister",
      issueByKey: new Map([["a", 12]]),
      titleByKey: new Map([["z", "Voce Z"]]),
    };
    const { body } = issueContent(item, ctx);
    expect(body).toContain("Dipende da: #12, Voce Z");
  });
  it("piè di pagina con nome app e id voce", () => {
    const item = comp("a");
    const { body, title, labels } = issueContent(item, { appName: "Mister", issueByKey: new Map(), titleByKey: new Map() });
    expect(body.endsWith(`\n\n---\nCreata da Casello · piano di Mister · voce #${item.id}`)).toBe(true);
    expect(title).toBe("Titolo a");
    expect(labels).toContain("casello");
  });
});
