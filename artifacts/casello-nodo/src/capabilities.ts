import { readdir } from "node:fs/promises";
import path from "node:path";

/** Versione del pacchetto `casello-nodo` (allineata a package.json, verificata dai test). */
export const NODE_VERSION = "0.1.0";
export const NODE_EXECUTOR = "claude-code";

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function hasSkillFile(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.includes("SKILL.md");
  } catch {
    return false;
  }
}

/**
 * Nomi delle skill presenti nelle cartelle date: ogni sottocartella con `SKILL.md` è una skill; nella cache dei
 * plugin (`<marketplace>/<plugin>/<versione>/skills/<skill>`) il nome è `<plugin>:<skill>`.
 */
export async function scanSkills(dirs: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of dirs) {
    for (const name of await subdirs(dir)) {
      if (await hasSkillFile(path.join(dir, name))) found.add(name);
    }
    for (const marketplace of await subdirs(dir)) {
      for (const plugin of await subdirs(path.join(dir, marketplace))) {
        for (const version of await subdirs(path.join(dir, marketplace, plugin))) {
          const skillsDir = path.join(dir, marketplace, plugin, version, "skills");
          for (const skill of await subdirs(skillsDir)) {
            if (await hasSkillFile(path.join(skillsDir, skill))) found.add(`${plugin}:${skill}`);
          }
        }
      }
    }
  }
  return [...found].sort();
}
