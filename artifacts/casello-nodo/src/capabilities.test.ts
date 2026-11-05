import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { latestVersion, NODE_EXECUTOR, NODE_VERSION, scanFolders, scanSkills } from "./capabilities";
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

  it("nomi non validi per l'heartbeat ignorati con un avviso; al massimo 500 skill", async () => {
    const long = "x".repeat(101);
    await skill("skills", long);
    await skill("cache", "m", "p".repeat(60), "1.0.0", "skills", "s".repeat(45));
    for (let i = 0; i < 502; i++) await skill("skills", `skill-${String(i).padStart(3, "0")}`);
    const warnings: string[] = [];
    const skills = await scanSkills([path.join(dir, "skills"), path.join(dir, "cache")], { warn: (m) => warnings.push(m) });
    expect(skills).toHaveLength(500);
    expect(skills).not.toContain(long);
    expect(skills.every((s) => s.length <= 100)).toBe(true);
    expect(skills[0]).toBe("skill-000");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("ignorate 2 skill con un nome non valido");
    expect(warnings[1]).toContain("oltre 500");
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

describe("scanFolders", () => {
  const mk = (...parts: string[]) => mkdir(path.join(dir, ...parts), { recursive: true });

  it("cartelle fino a 3 livelli, percorsi relativi con / in ordine; mai i file", async () => {
    await mk("clienti", "acme", "wi-1174", "sorgenti");
    await mk("lavoro 1");
    await writeFile(path.join(dir, "clienti", "nota.txt"), "x");
    expect(await scanFolders(dir)).toEqual(["clienti", "clienti/acme", "clienti/acme/wi-1174", "lavoro 1"]);
  });

  it("salta nascoste, node_modules, casello-allegati e nomi non ammessi con il loro contenuto", async () => {
    await mk(".git", "objects");
    await mk("progetto", "node_modules", "x");
    await mk("progetto", "casello-allegati");
    await mk("con$dollaro", "dentro");
    await mk("ok");
    expect(await scanFolders(dir)).toEqual(["ok", "progetto"]);
  });

  it("non segue i link simbolici, nemmeno verso fuori dalla radice", async () => {
    const { dir: outside, cleanup: done } = await tempDir();
    try {
      await mkdir(path.join(outside, "segreto"));
      await symlink(outside, path.join(dir, "fuori"));
      await mk("dentro");
      await symlink(path.join(dir, "dentro"), path.join(dir, "collegamento"));
      expect(await scanFolders(dir)).toEqual(["dentro"]);
    } finally {
      await done();
    }
  });

  it("al massimo 2 000 cartelle, prima le meno profonde", async () => {
    for (let i = 0; i < 1999; i++) await mk(`c${String(i).padStart(4, "0")}`);
    await mk("zz", "profonda");
    const found = await scanFolders(dir);
    expect(found).toHaveLength(2000);
    expect(found).toContain("zz");
    expect(found).not.toContain("zz/profonda");
  });

  it("radice inesistente → elenco vuoto", async () => {
    expect(await scanFolders(path.join(dir, "manca"))).toEqual([]);
  });
});
