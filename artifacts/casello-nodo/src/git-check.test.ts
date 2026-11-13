import { describe, expect, it, vi } from "vitest";
import { checkGit, createCachedGitStatus, installGit, locateGit } from "./git-check";

describe("locateGit", () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  it("preferisce Homebrew, poi /usr/local, senza lanciare comandi", async () => {
    const run = vi.fn(async () => "/Library/Developer/CommandLineTools");
    expect(await locateGit({ exists: exists(["/opt/homebrew/bin/git", "/usr/bin/git"]), run })).toBe("/opt/homebrew/bin/git");
    expect(await locateGit({ exists: exists(["/usr/local/bin/git", "/usr/bin/git"]), run })).toBe("/usr/local/bin/git");
    expect(run).not.toHaveBeenCalled();
  });

  it("/usr/bin/git solo se `xcode-select -p` riesce (altrimenti è il rimando che apre il dialogo di macOS)", async () => {
    const calls: string[][] = [];
    const ok = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return "/Library/Developer/CommandLineTools";
    };
    expect(await locateGit({ exists: exists(["/usr/bin/git"]), run: ok })).toBe("/usr/bin/git");
    expect(calls).toEqual([["/usr/bin/xcode-select", "-p"]]);
    expect(await locateGit({ exists: exists(["/usr/bin/git"]), run: async () => null })).toBeNull();
    expect(
      await locateGit({
        exists: exists(["/usr/bin/git"]),
        run: async () => {
          throw new Error("x");
        },
      }),
    ).toBeNull();
    expect(await locateGit({ exists: exists([]), run: ok })).toBeNull();
  });
});

describe("checkGit", () => {
  it("estrae la versione da `<git> --version` del Git trovato", async () => {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return "git version 2.39.5 (Apple Git-154)\n";
    };
    expect(await checkGit({ run, locate: async () => "/usr/bin/git" })).toEqual({ found: true, version: "2.39.5" });
    expect(calls).toEqual([["/usr/bin/git", "--version"]]);
  });

  it("Git non trovato → non trovato, senza lanciare nulla", async () => {
    const run = vi.fn(async () => "git version 2.0.0");
    expect(await checkGit({ run, locate: async () => null })).toEqual({ found: false, version: null });
    expect(run).not.toHaveBeenCalled();
  });

  it("comando fallito → non trovato", async () => {
    const locate = async () => "/opt/homebrew/bin/git";
    expect(await checkGit({ run: async () => null, locate })).toEqual({ found: false, version: null });
    expect(
      await checkGit({
        run: async () => {
          throw new Error("ENOENT");
        },
        locate,
      }),
    ).toEqual({ found: false, version: null });
  });

  it("uscita non riconosciuta → trovato senza versione; versione tagliata a 50", async () => {
    const locate = async () => "/opt/homebrew/bin/git";
    expect(await checkGit({ run: async () => "boh", locate })).toEqual({ found: true, version: null });
    const long = await checkGit({ run: async () => `git version ${"1".repeat(80)}`, locate });
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
