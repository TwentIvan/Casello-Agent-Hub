import { describe, expect, it } from "vitest";
import { readMergeArgs } from "./merge-args";

describe("readMergeArgs", () => {
  it("legge gli script -post validi", () => {
    const m = readMergeArgs({ postScripts: [{ path: "docs/migrations/x-post.sql", sql: "DROP TABLE a;" }] });
    expect(m.postScripts).toEqual([{ path: "docs/migrations/x-post.sql", sql: "DROP TABLE a;" }]);
  });
  it("scarta le voci senza path o sql stringa", () => {
    const m = readMergeArgs({
      postScripts: [{ path: "a" }, { sql: "b" }, { path: 1, sql: "c" }, null, "x", { path: "ok", sql: "s" }],
    });
    expect(m.postScripts).toEqual([{ path: "ok", sql: "s" }]);
  });
  it("assente o non array: elenco vuoto", () => {
    expect(readMergeArgs({}).postScripts).toEqual([]);
    expect(readMergeArgs({ postScripts: "x" }).postScripts).toEqual([]);
    expect(readMergeArgs(null).postScripts).toEqual([]);
  });
});
