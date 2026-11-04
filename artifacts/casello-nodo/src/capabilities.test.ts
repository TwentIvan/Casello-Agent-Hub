import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { latestVersion, NODE_EXECUTOR, NODE_VERSION, scanSkills } from "./capabilities";
import { tempDir } from "./test/helpers";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => cleanup());

async function skill(...parts: string[]): Promise<void> {
  await mkdir(path.join(dir, ...parts), { recursive: true });
  await writeFile(path.join(dir, ...parts, "SKILL.md"), "# skill");
}

describe("scanSkills", () => {
  it("trova le skill dirette e quelle dei plugin", async () => {
    await skill("skills", "casello-architetto-locale");
    await skill("skills", "sap-code-review");
    await mkdir(path.join(dir, "skills", "senza-skill-md"), { recursive: true });
    await writeFile(path.join(dir, "skills", "file.txt"), "x");
    await skill("cache", "mercato", "drg-sibilla", "2.0.3", "skills", "drg-sibilla");
    await skill("cache", "mercato", "drg-sibilla", "2.0.2", "skills", "drg-sibilla");
    await skill("cache", "mercato", "superpowers", "5.0.0", "skills", "brainstorming");
    await skill("cache", "mercato", "superpowers", "5.0.0", "skills", "writing-plans");

    const skills = await scanSkills([path.join(dir, "skills"), path.join(dir, "cache"), path.join(dir, "manca")]);
    expect(skills).toEqual([
      "casello-architetto-locale",
      "drg-sibilla:drg-sibilla",
      "sap-code-review",
      "superpowers:brainstorming",
      "superpowers:writing-plans",
    ]);
  });

  it("cartelle vuote o inesistenti → nessuna skill", async () => {
    expect(await scanSkills([dir, path.join(dir, "nessuna")])).toEqual([]);
  });
});

describe("capacità", () => {
  it("la versione è quella del pacchetto", async () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
    expect(NODE_VERSION).toBe(pkg.version);
    expect(NODE_EXECUTOR).toBe("claude-code");
  });
});

describe("versione dei plugin", () => {
  it("conta solo la versione più alta di ogni plugin", async () => {
    await skill("cache", "m", "p", "1.9.0", "skills", "vecchia");
    await skill("cache", "m", "p", "1.10.0", "skills", "nuova");
    await skill("cache", "m", "p", "1.10.0-beta.1", "skills", "beta");
    const skills = await scanSkills([path.join(dir, "cache")]);
    expect(skills).toEqual(["p:nuova"]);
  });

  it("latestVersion: semver, poi ordine lessicografico", () => {
    expect(latestVersion(["2.0.2", "2.0.10", "2.0.3"])).toBe("2.0.10");
    expect(latestVersion(["1.0.0-rc.1", "1.0.0"])).toBe("1.0.0");
    expect(latestVersion(["abc", "abd"])).toBe("abd");
    expect(latestVersion([])).toBeNull();
  });
});
