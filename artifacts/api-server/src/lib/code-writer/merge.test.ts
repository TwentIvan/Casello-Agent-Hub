import { describe, expect, it } from "vitest";
import { classifyPull, MAX_POST_SQL_BYTES, MERGE_MESSAGES, migrationsToRead, parseMergeArgs } from "./merge";
import type { PullFile } from "./github-git";
import { mergeInstruction } from "../teams/turn-runner";
import type { InstanceRole } from "../teams/manifest";

const f = (filename: string, status = "added", previousFilename: string | null = null): PullFile => ({ filename, status, previousFilename });
const ADD = "CREATE TABLE IF NOT EXISTS t (id int);\n";

describe("classificazione della PR", () => {
  it("workflow: rifiuto, prima di ogni altro caso", () => {
    expect(classifyPull([f(".github/workflows/ci.yml", "modified"), f("docs/migrations/2026-11-x.sql")], {})).toEqual({ kind: "refuse", message: MERGE_MESSAGES.workflows });
    // anche come nome precedente di un rinominato
    expect(classifyPull([f("ci.yml", "renamed", ".github/workflows/ci.yml")], {})).toEqual({ kind: "refuse", message: MERGE_MESSAGES.workflows });
  });

  it("migrazione esistente modificata, tolta o rinominata: rifiuto", () => {
    for (const file of [
      f("docs/migrations/2026-11-a.sql", "modified"),
      f("docs/migrations/2026-11-a.sql", "removed"),
      f("docs/migrations/2026-11-16-b.sql", "renamed", "docs/migrations/2026-11-a.sql"),
      f("docs/old.sql", "renamed", "docs/migrations/2026-11-a.sql"),
    ]) {
      expect(classifyPull([file], {})).toEqual({ kind: "refuse", message: MERGE_MESSAGES.migrationModified });
    }
  });

  it("nome fuori formato, anche per un -post o in una sottocartella: rifiuto", () => {
    expect(classifyPull([f("docs/migrations/2026-11-x.sql")], { "docs/migrations/2026-11-x.sql": ADD })).toEqual({ kind: "refuse", message: MERGE_MESSAGES.migrationName });
    expect(classifyPull([f("docs/migrations/x-post.sql")], { "docs/migrations/x-post.sql": "DROP TABLE t;" })).toEqual({ kind: "refuse", message: MERGE_MESSAGES.migrationName });
    expect(classifyPull([f("docs/migrations/a/2026-11-16-x.sql")], { "docs/migrations/a/2026-11-16-x.sql": ADD })).toEqual({ kind: "refuse", message: MERGE_MESSAGES.migrationName });
  });

  it("migrazione nuova distruttiva non -post: rifiuto con il nome", () => {
    expect(classifyPull([f("docs/migrations/2026-11-16-x.sql")], { "docs/migrations/2026-11-16-x.sql": "DROP TABLE t;\n" })).toEqual({
      kind: "refuse",
      message: MERGE_MESSAGES.migrationDestructive("2026-11-16-x.sql"),
    });
  });

  it("schema cambiato senza migrazione nuova: rifiuto", () => {
    expect(classifyPull([f("lib/db/src/schema/a.ts", "modified")], {})).toEqual({ kind: "refuse", message: MERGE_MESSAGES.schemaWithoutMigration });
    expect(classifyPull([f("docs/schema-casello.sql", "modified")], {})).toEqual({ kind: "refuse", message: MERGE_MESSAGES.schemaWithoutMigration });
  });

  it("migrazioni additive, con o senza schema, e PR senza migrazioni: merge", () => {
    const add = { "docs/migrations/2026-11-16-x.sql": ADD };
    expect(classifyPull([f("docs/schema-casello.sql", "modified"), f("docs/migrations/2026-11-16-x.sql")], add)).toEqual({ kind: "merge" });
    expect(classifyPull([f("docs/migrations/2026-11-16-x.sql"), f("src/a.ts", "modified")], add)).toEqual({ kind: "merge" });
    expect(classifyPull([f("src/a.ts", "modified"), f("docs/schema-casello.sql.bak", "modified")], {})).toEqual({ kind: "merge" });
    // le note in docs/migrations/ non sono migrazioni
    expect(classifyPull([f("docs/migrations/LEGGIMI.md", "modified"), f("docs/migrations/note.md")], {})).toEqual({ kind: "merge" });
  });

  it("script -post: voce in coda con il contenuto intero, anche con lo schema cambiato", () => {
    const post = "ALTER TABLE t DROP COLUMN c;\n";
    expect(
      classifyPull([f("lib/db/src/schema/a.ts", "modified"), f("docs/migrations/2026-11-16-y-post.sql"), f("docs/migrations/2026-11-16-y.sql")], {
        "docs/migrations/2026-11-16-y-post.sql": post,
        "docs/migrations/2026-11-16-y.sql": ADD,
      }),
    ).toEqual({
      kind: "queue",
      postScripts: [{ path: "docs/migrations/2026-11-16-y-post.sql", sql: post }],
      files: ["lib/db/src/schema/a.ts", "docs/migrations/2026-11-16-y-post.sql", "docs/migrations/2026-11-16-y.sql"],
    });
  });

  it("script -post oltre 100 000 byte in tutto: rifiuto", () => {
    const half = "-- " + "é".repeat(25_000) + "\n"; // 50 004 byte UTF-8
    const files = [f("docs/migrations/2026-11-16-a-post.sql"), f("docs/migrations/2026-11-16-b-post.sql")];
    expect(MAX_POST_SQL_BYTES).toBe(100_000);
    expect(classifyPull(files, { "docs/migrations/2026-11-16-a-post.sql": half, "docs/migrations/2026-11-16-b-post.sql": half })).toEqual({
      kind: "refuse",
      message: MERGE_MESSAGES.postTooLong,
    });
    expect(classifyPull(files.slice(0, 1), { "docs/migrations/2026-11-16-a-post.sql": half })).toMatchObject({ kind: "queue" });
  });

  it("nessun file di migrazione: merge", () => {
    expect(classifyPull([], {})).toEqual({ kind: "merge" });
  });
});

describe("file da leggere", () => {
  it("solo le migrazioni .sql aggiunte", () => {
    expect(migrationsToRead([f("docs/migrations/2026-11-16-x.sql"), f("docs/migrations/a.md"), f("docs/migrations/2026-11-a.sql", "modified"), f("src/a.sql")])).toEqual([
      "docs/migrations/2026-11-16-x.sql",
    ]);
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
    expect(withPuller).toContain("-post");
    expect(withPuller).toContain("YYYY-MM-DD-slug.sql");
    expect(mergeInstruction([role({ key: "capo", isLead: true, code: "merge" })])).toContain("tu stesso con `unisci_pr`");
  });
});
