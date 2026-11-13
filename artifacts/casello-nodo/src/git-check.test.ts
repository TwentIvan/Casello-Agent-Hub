import { describe, expect, it, vi } from "vitest";
import { checkGit, createCachedGitStatus, installGit } from "./git-check";

describe("checkGit", () => {
  it("estrae la versione da `git --version`", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return "git version 2.39.5 (Apple Git-154)\n";
    };
    expect(await checkGit({ run })).toEqual({ found: true, version: "2.39.5" });
    expect(calls).toEqual([["git", "--version"]]);
  });

  it("git assente o comando fallito → non trovato", async () => {
    expect(await checkGit({ run: async () => null })).toEqual({ found: false, version: null });
    expect(
      await checkGit({
        run: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual({ found: false, version: null });
  });

  it("uscita non riconosciuta → trovato senza versione; versione tagliata a 50", async () => {
    expect(await checkGit({ run: async () => "boh" })).toEqual({ found: true, version: null });
    const long = await checkGit({ run: async () => `git version ${"1".repeat(80)}` });
    expect(long.version).toHaveLength(50);
  });
});

describe("createCachedGitStatus", () => {
  it("riusa il risultato per 10 minuti", async () => {
    let t = 0;
    const check = vi.fn(async () => ({ found: true, version: "2.0.0" }));
    const get = createCachedGitStatus(check, () => t);
    await get();
    t = 599_000;
    await get();
    expect(check).toHaveBeenCalledTimes(1);
    t = 600_000;
    await get();
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe("installGit", () => {
  it("lancia xcode-select --install e notifica", async () => {
    const calls: string[][] = [];
    const notes: string[] = [];
    await installGit({
      exec: async (file, args) => void calls.push([file, ...args]),
      notify: async (t) => void notes.push(t),
    });
    expect(calls).toEqual([["/usr/bin/xcode-select", "--install"]]);
    expect(notes).toEqual(["Segui il dialogo di macOS; Botcave Nodo se ne accorge da solo"]);
  });

  it("ignora gli errori del comando (già in corso o installato)", async () => {
    const notes: string[] = [];
    await installGit({
      exec: async () => {
        throw new Error("x");
      },
      notify: async (t) => void notes.push(t),
    });
    expect(notes).toHaveLength(1);
  });
});
