import { describe, expect, it } from "vitest";
import { classifyPullFiles, parseMergeArgs } from "./merge";
import { mergeInstruction } from "../teams/turn-runner";
import type { InstanceRole } from "../teams/manifest";

describe("file della PR", () => {
  it("workflow, migrazioni e schema; nomi precedenti compresi, senza ripetizioni", () => {
    expect(
      classifyPullFiles([
        "src/a.ts",
        ".github/workflows/ci.yml",
        "docs/migrations/2026-11-x.sql",
        "docs/migrations/2026-11-x.sql",
        "lib/db/src/schema/runs.ts",
        "docs/schema-casello.sql",
        "docs/schema-casello.sql.bak",
        "docs/migrations-note.md",
      ]),
    ).toEqual({
      workflows: [".github/workflows/ci.yml"],
      migrations: ["docs/migrations/2026-11-x.sql", "lib/db/src/schema/runs.ts", "docs/schema-casello.sql"],
    });
    expect(classifyPullFiles(["src/a.ts", "README.md"])).toEqual({ workflows: [], migrations: [] });
  });
});

describe("argomenti di unisci_pr", () => {
  it("compito oppure numero, mai entrambi né altro", () => {
    expect(parseMergeArgs({ compito: "t3" })).toEqual({ compito: "t3" });
    expect(parseMergeArgs({ numero: 12 })).toEqual({ numero: 12 });
    expect(parseMergeArgs({ compito: "t3", numero: 12 })).toBeNull();
    expect(parseMergeArgs({})).toBeNull();
    expect(parseMergeArgs({ numero: 0 })).toBeNull();
    expect(parseMergeArgs({ numero: 1.5 })).toBeNull();
    expect(parseMergeArgs({ compito: "../main" })).toBeNull();
    expect(parseMergeArgs({ compito: "t3", sha: "abc" })).toBeNull();
  });
});

describe("regola del merge nel prompt del capo", () => {
  const role = (over: Partial<InstanceRole>): InstanceRole => ({
    key: "r",
    name: "R",
    task: "",
    isLead: false,
    runsOn: "cloud",
    aiModelId: 1,
    code: "none",
    tools: [],
    skills: [],
    localSkills: [],
    ...over,
  });

  it("senza ruoli merge il merge resta dell'utente", () => {
    expect(mergeInstruction([role({ key: "capo", isLead: true }), role({ key: "dev", code: "write" })])).toContain("Il merge delle PR è dell'utente");
  });

  it("con un ruolo merge si assegna il merge; con il capo merge usa unisci_pr", () => {
    const withPuller = mergeInstruction([role({ key: "capo", isLead: true }), role({ key: "puller", code: "merge" })]);
    expect(withPuller).toContain("il ruolo puller");
    expect(withPuller).not.toContain("dell'utente su GitHub");
    expect(withPuller).toContain("Da confermare");
    expect(mergeInstruction([role({ key: "capo", isLead: true, code: "merge" })])).toContain("tu stesso con `unisci_pr`");
  });
});
