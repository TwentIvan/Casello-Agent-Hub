import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SOURCE_LIMITS, SourceTree, SourceTreeError } from "./source-tree";

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries);
}

describe("SourceTree", () => {
  it("legge e lista", () => {
    const tree = SourceTree.fromZip(
      zip({ "src/a.ts": "const a = 1;\n", "src/b/c.ts": "export {};\n" }),
    );
    expect(tree.list("src")).toEqual(["src/a.ts", "src/b/"]);
    expect(tree.list("")).toEqual(["src/"]);
    expect(tree.list("/")).toEqual(["src/"]);
    expect(tree.list("src", 2)).toEqual(["src/a.ts", "src/b/", "src/b/c.ts"]);
    expect(tree.read("src/a.ts").content).toBe("const a = 1;");
    expect(tree.read("./src/a.ts").totalLines).toBe(1);
    expect(tree.has("src/b/c.ts")).toBe(true);
    expect(tree.fileCount).toBe(2);
    expect(() => tree.list("nope")).toThrow(SourceTreeError);
    expect(() => tree.read("nope.ts")).toThrow(SourceTreeError);
  });

  it("toglie la cartella radice", () => {
    const bytes = zip({
      "repo-abc123/src/a.ts": "x",
      "repo-abc123/README.md": "y",
    });
    const tree = SourceTree.fromZip(bytes, { stripTopFolder: true });
    expect(tree.has("src/a.ts")).toBe(true);
    expect(tree.has("README.md")).toBe(true);
    const kept = SourceTree.fromZip(bytes);
    expect(kept.has("repo-abc123/src/a.ts")).toBe(true);
  });

  it("scarta percorsi pericolosi", () => {
    const tree = SourceTree.fromZip(
      zip({
        "../evil.ts": "x",
        "/etc/passwd": "x",
        "a/../../x.ts": "x",
        "C:/win.ts": "x",
        "ok.ts": "x",
      }),
    );
    expect(tree.has("evil.ts")).toBe(false);
    expect(tree.has("../evil.ts")).toBe(false);
    expect(tree.has("etc/passwd")).toBe(false);
    expect(tree.has("/etc/passwd")).toBe(false);
    expect(tree.has("x.ts")).toBe(false);
    expect(tree.has("win.ts")).toBe(false);
    expect(tree.fileCount).toBe(1);
    expect(() => tree.read("../evil.ts")).toThrow(SourceTreeError);
  });

  it("esclude binari, cartelle ignorate e file grandi", () => {
    const tree = SourceTree.fromZip(
      zip({
        "src/ok.ts": "ok",
        "logo.png": "not really a png",
        "data.bin": new Uint8Array([1, 2, 0, 3]),
        "node_modules/x/index.js": "x",
        ".git/config": "x",
        "dist/out.js": "x",
        "big.ts": "a".repeat(SOURCE_LIMITS.maxFileBytes + 1),
      }),
    );
    expect(tree.fileCount).toBe(1);
    expect(tree.skipped).toEqual({ binary: 2, tooLarge: 1, ignored: 3 });
  });

  it("zip bomb: file troppo grande escluso in base alla dimensione dichiarata", () => {
    const bomb = new Uint8Array(300 * 1024).fill(0x61);
    const tree = SourceTree.fromZip(zip({ "bomb.txt": bomb, "a.ts": "x" }));
    expect(tree.has("bomb.txt")).toBe(false);
    expect(tree.skipped.tooLarge).toBe(1);
    expect(tree.has("a.ts")).toBe(true);
  });

  it("zip bomb: totale oltre il limite", () => {
    const chunk = "a".repeat(SOURCE_LIMITS.maxFileBytes);
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) files[`f${i}.txt`] = chunk;
    expect(() => SourceTree.fromZip(zip(files))).toThrow(/limite/);
    expect(() => SourceTree.fromZip(zip(files))).toThrow(SourceTreeError);
  });

  it("zip oltre maxZipBytes", () => {
    const big = new Uint8Array(SOURCE_LIMITS.maxZipBytes + 1);
    expect(() => SourceTree.fromZip(big)).toThrow(/limite/);
  });

  it("troppi file", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= SOURCE_LIMITS.maxFiles; i++) files[`d/f${i}.txt`] = "x";
    expect(() => SourceTree.fromZip(zip(files))).toThrow(/limite/);
  });

  it("zip non valido", () => {
    expect(() => SourceTree.fromZip(new Uint8Array([1, 2, 3]))).toThrow(
      SourceTreeError,
    );
  });

  it("read paginato", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `riga ${i + 1}`);
    const tree = SourceTree.fromZip(zip({ "big.txt": lines.join("\n") + "\n" }));
    const first = tree.read("big.txt");
    expect(first.totalLines).toBe(1000);
    expect(first.truncated).toBe(true);
    expect(first.content.split("\n")).toHaveLength(400);
    expect(first.content.startsWith("riga 1\n")).toBe(true);
    const part = tree.read("big.txt", 10, 12);
    expect(part.content).toBe("riga 10\nriga 11\nriga 12");
    const rest = tree.read("big.txt", 990);
    expect(rest.truncated).toBe(false);
    expect(rest.content.endsWith("riga 1000")).toBe(true);
    const wide = tree.read("big.txt", 1, 1000);
    expect(wide.content.split("\n")).toHaveLength(400);
  });

  it("read limita i caratteri", () => {
    const tree = SourceTree.fromZip(
      zip({ "w.txt": Array(300).fill("x".repeat(200)).join("\n") }),
    );
    const r = tree.read("w.txt");
    expect(r.content.length).toBeLessThanOrEqual(SOURCE_LIMITS.maxReadChars);
    expect(r.truncated).toBe(true);
  });

  it("search", () => {
    const tree = SourceTree.fromZip(
      zip({
        "src/a.ts": "const Foo = 1;\nconst bar = 2;\n  foo again\n",
        "src/b.js": "foo in js\n",
        "docs/x.md": "foo doc\n",
      }),
    );
    const sub = tree.search("FOO");
    expect(sub.map((r) => `${r.path}:${r.line}`)).toEqual([
      "docs/x.md:1",
      "src/a.ts:1",
      "src/a.ts:3",
      "src/b.js:1",
    ]);
    expect(sub[2]!.text).toBe("foo again");
    expect(tree.search("^const \\w+ = \\d", { regex: true })).toHaveLength(2);
    expect(
      tree.search("foo", { glob: "**/*.ts" }).map((r) => r.path),
    ).toEqual(["src/a.ts", "src/a.ts"]);
    expect(tree.search("foo", { glob: "src/*.js" })).toHaveLength(1);
    expect(tree.search("foo", { glob: "src/?.js" })).toHaveLength(1);
    expect(tree.search("foo", { glob: "*.ts" })).toHaveLength(0);
    expect(() => tree.search("(", { regex: true })).toThrow(SourceTreeError);
  });

  it("search limita i risultati e il testo", () => {
    const tree = SourceTree.fromZip(
      zip({ "m.txt": Array(250).fill("match " + "z".repeat(500)).join("\n") }),
    );
    const res = tree.search("match");
    expect(res).toHaveLength(SOURCE_LIMITS.maxSearchResults);
    expect(res[0]!.text.length).toBe(200);
  });
});
