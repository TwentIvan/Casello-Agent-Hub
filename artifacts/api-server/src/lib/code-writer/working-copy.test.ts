import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceTree } from "../architect/source-tree";
import { checkPath, WorkingCopy } from "./working-copy";

function tree(files: Record<string, string>): SourceTree {
  const e: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) e[k] = strToU8(v);
  return SourceTree.fromZip(zipSync(e));
}

describe("checkPath", () => {
  it("rifiuta i percorsi pericolosi", () => {
    for (const p of ["../a", "/a", "a//b", ".git/config", ".github/workflows/ci.yml", ".env.local", ".env", "a\\b", "a/./b"]) {
      expect(checkPath(p), p).not.toBeNull();
    }
    expect(checkPath("src/a.ts")).toBeNull();
    expect(checkPath("a".repeat(301))).not.toBeNull();
  });
});

describe("WorkingCopy", () => {
  it("modifica di un file nuovo", () => {
    const wc = new WorkingCopy(tree({ "a.ts": "x\n" }));
    expect(wc.write("n.ts", "ciao mondo\n")).toBeNull();
    expect(wc.edit("n.ts", "mondo", "Botcave")).toBeNull();
    expect(wc.view().text("n.ts")).toBe("ciao Botcave\n");
    expect(wc.pendingCount()).toBe(1);
  });

  it("edit: 0 e 2 occorrenze", () => {
    const wc = new WorkingCopy(tree({ "a.ts": "aa bb aa\n" }));
    expect(wc.edit("a.ts", "zz", "y")).toMatch(/non trovato/);
    expect(wc.edit("a.ts", "aa", "y")).toMatch(/2 volte/);
    expect(wc.edit("nope.ts", "a", "b")).toMatch(/inesistente/);
    expect(wc.edit("a.ts", "bb", "cc")).toBeNull();
    expect(wc.view().text("a.ts")).toBe("aa cc aa\n");
  });

  it("remove toglie il file dalla vista", () => {
    const wc = new WorkingCopy(tree({ "a.ts": "x", "b.ts": "y" }));
    expect(wc.remove("a.ts")).toBeNull();
    expect(wc.view().list("")).toEqual(["b.ts"]);
    expect(wc.remove("a.ts")).toMatch(/inesistente/);
    expect(wc.pending().get("a.ts")).toBeNull();
  });

  it("remove di un file solo in sospeso lo dimentica invece di eliminarlo", () => {
    const wc = new WorkingCopy(tree({ "a.ts": "x\n" }));
    expect(wc.write("n.ts", "nuovo\n")).toBeNull();
    expect(wc.remove("n.ts")).toBeNull();
    expect(wc.pending().has("n.ts")).toBe(false);
    expect(wc.pendingCount()).toBe(0);
    expect(wc.view().has("n.ts")).toBe(false);
    // Già committato: l'eliminazione deve arrivare al commit successivo
    expect(wc.write("c.ts", "c\n")).toBeNull();
    wc.markCommitted();
    expect(wc.remove("c.ts")).toBeNull();
    expect(wc.pending().get("c.ts")).toBeNull();
  });

  it("rifiuta il 101° file", () => {
    const wc = new WorkingCopy(tree({ "a.ts": "x" }));
    for (let i = 0; i < 100; i++) expect(wc.write(`f${i}.ts`, "x")).toBeNull();
    expect(wc.write("f100.ts", "x")).toMatch(/troppi file/);
    expect(wc.write("f0.ts", "y")).toBeNull();
  });

  it("limiti del file: NUL e dimensione", () => {
    const wc = new WorkingCopy(tree({}));
    expect(wc.write("a.bin", "a\0b")).toMatch(/UTF-8/);
    expect(wc.write("big.txt", "x".repeat(1_048_577))).toMatch(/troppo grande/);
    expect(wc.write("ok.txt", "x".repeat(1_048_576))).toBeNull();
    expect(wc.write(".github/workflows/a.yml", "x")).toMatch(/workflow/);
  });

  it("markCommitted mantiene la vista", () => {
    const wc = new WorkingCopy(tree({ "a.ts": "x" }));
    wc.write("n.ts", "nuovo");
    wc.remove("a.ts");
    wc.markCommitted();
    expect(wc.pendingCount()).toBe(0);
    expect(wc.view().text("n.ts")).toBe("nuovo");
    expect(wc.view().has("a.ts")).toBe(false);
    expect(wc.edit("n.ts", "nuovo", "v2")).toBeNull();
    expect(wc.pending().size).toBe(1);
  });
  it("una vista superata si chiude quando se ne costruisce una nuova; dispose chiude tutto", async () => {
    const base = tree({ "a.ts": "x\n" });
    const wc = new WorkingCopy(base);
    const v1 = wc.view();
    expect(wc.write("a.ts", "y\n")).toBeNull();
    expect(v1.isDisposed).toBe(false);
    const v2 = wc.view();
    expect(v1.isDisposed).toBe(true);
    expect(v2.isDisposed).toBe(false);
    expect(base.isDisposed).toBe(false);
    await wc.dispose();
    expect(v2.isDisposed).toBe(true);
    expect(base.isDisposed).toBe(true);
  });
});
