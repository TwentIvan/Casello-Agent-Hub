import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneAt, gitAuthEnv } from "./clone";

let base: string;
let sha: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "collaudo-clone-"));
  const src = path.join(base, "o", "r");
  execFileSync("git", ["init", "-q", src]);
  await writeFile(path.join(src, "LEGGIMI.md"), "ciao\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["-C", src, "add", "."], { env });
  execFileSync("git", ["-C", src, "commit", "-q", "-m", "primo"], { env });
  execFileSync("git", ["clone", "-q", "--bare", src, path.join(base, "o", "r.git")]);
  sha = execFileSync("git", ["-C", src, "rev-parse", "HEAD"]).toString().trim();
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("cloneAt", () => {
  it("copia il repository allo sha senza lasciare il token su disco", async () => {
    const dir = path.join(base, "copia");
    await cloneAt("o/r", sha, "ghs_segretissimo", dir, { gitBase: `file://${base}` });
    expect(await readFile(path.join(dir, "LEGGIMI.md"), "utf8")).toBe("ciao\n");
    expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim()).toBe(sha);
    expect(await readFile(path.join(dir, ".git", "config"), "utf8")).not.toContain("ghs_");
    expect(await readFile(path.join(dir, ".git", "config"), "utf8")).not.toContain("AUTHORIZATION");
  });

  it("repository o sha non validi → errore prima di git", async () => {
    await expect(cloneAt("o/r; rm -rf /", sha, "t", path.join(base, "x"))).rejects.toThrow("repository o sha non validi");
    await expect(cloneAt("o/r", "HEAD", "t", path.join(base, "x"))).rejects.toThrow("repository o sha non validi");
  });

  it("l'header di autenticazione è basic con x-access-token", () => {
    const env = gitAuthEnv("abc");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:abc").toString("base64")}`);
  });
});
