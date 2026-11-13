import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  NodeHeartbeatBody,
  nodeHeartbeatBodyFoldersItemMax,
  nodeHeartbeatBodyFoldersMax,
  nodeHeartbeatBodySkillsMax,
} from "@workspace/api-zod";
import type { Logger } from "./log";

/** Schema di un nome di skill nell'heartbeat (lunghezza ed eventuale formato del contratto). */
const SkillName = NodeHeartbeatBody.shape.skills.element;

/** Iniettata dalla build (`esbuild --define:__NODE_VERSION__`, letta da package.json); assente con tsx e nei test. */
declare const __NODE_VERSION__: string | undefined;

/**
 * Versione del pacchetto `casello-nodo`: quella della build; senza build (tsx, test) la costante di riserva, allineata a
 * package.json (verificata dai test).
 */
export const NODE_VERSION: string = typeof __NODE_VERSION__ === "string" && __NODE_VERSION__ !== "" ? __NODE_VERSION__ : "0.4.0";
export const NODE_EXECUTOR = "claude-code";

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Confronto semver (pre-release prima della versione finale); null se uno dei due non è semver. */
function compareSemver(a: string, b: string): number | null {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  if (ma[4] === mb[4]) return 0;
  if (ma[4] === undefined) return 1;
  if (mb[4] === undefined) return -1;
  return ma[4] < mb[4] ? -1 : 1;
}

/** Versione più alta tra le cartelle di un plugin: semver, altrimenti ordine lessicografico. */
export function latestVersion(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (best === null) {
      best = v;
      continue;
    }
    const cmp = compareSemver(v, best) ?? (v < best ? -1 : v > best ? 1 : 0);
    if (cmp > 0) best = v;
  }
  return best;
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
 * plugin (`<marketplace>/<plugin>/<versione>/skills/<skill>`) il nome è `<plugin>:<skill>`. I nomi che l'heartbeat
 * rifiuterebbe (es. oltre 100 caratteri) si tolgono e l'elenco si ferma a 500, con un avviso: un nome sbagliato non deve
 * bloccare l'heartbeat del nodo.
 */
export async function scanSkills(dirs: string[], logger?: Pick<Logger, "warn">): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of dirs) {
    for (const name of await subdirs(dir)) {
      if (await hasSkillFile(path.join(dir, name))) found.add(name);
    }
    for (const marketplace of await subdirs(dir)) {
      for (const plugin of await subdirs(path.join(dir, marketplace))) {
        // Solo la versione più recente presente in cache: le vecchie non sono quelle caricate da Claude Code
        const version = latestVersion(await subdirs(path.join(dir, marketplace, plugin)));
        if (version) {
          const skillsDir = path.join(dir, marketplace, plugin, version, "skills");
          for (const skill of await subdirs(skillsDir)) {
            if (await hasSkillFile(path.join(skillsDir, skill))) found.add(`${plugin}:${skill}`);
          }
        }
      }
    }
  }
  const sorted = [...found].sort();
  const valid = sorted.filter((name) => SkillName.safeParse(name).success);
  if (valid.length < sorted.length) {
    logger?.warn(`ignorate ${sorted.length - valid.length} skill con un nome non valido (al massimo 100 caratteri)`);
  }
  if (valid.length > nodeHeartbeatBodySkillsMax) {
    logger?.warn(`skill oltre ${nodeHeartbeatBodySkillsMax}: ne dichiaro solo ${nodeHeartbeatBodySkillsMax} (ignorate ${valid.length - nodeHeartbeatBodySkillsMax})`);
  }
  return valid.slice(0, nodeHeartbeatBodySkillsMax);
}

/** Profondità massima delle cartelle dichiarate sotto la radice (1 = solo le cartelle direttamente nella radice). */
export const FOLDERS_MAX_DEPTH = 3;
/** Cartelle lette al massimo per scansione: una radice enorme non rallenta l'heartbeat. */
const FOLDERS_MAX_READS = 5_000;
/** Segmento ammesso in uno spazio di lavoro (stesso formato che Casello accetta per `nodeWorkspace`). */
const FOLDER_SEGMENT = /^[A-Za-z0-9._ -]+$/;
const SKIPPED_FOLDERS = new Set(["node_modules", "casello-allegati"]);

/**
 * Sottocartelle della radice degli spazi di lavoro, come percorsi relativi con `/`, per la scelta in console: solo
 * nomi di cartelle, mai file. In ampiezza fino a 3 livelli e al massimo 2 000 voci (le meno profonde per prime);
 * saltate le cartelle nascoste, `node_modules`, `casello-allegati`, i nomi che uno spazio di lavoro non ammette (e ciò
 * che contengono) e i link simbolici, che non si seguono mai.
 */
export async function scanFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  let queue: string[] = [""];
  let reads = 0;
  for (let depth = 1; depth <= FOLDERS_MAX_DEPTH && queue.length > 0; depth++) {
    const next: string[] = [];
    for (const rel of queue) {
      if (reads >= FOLDERS_MAX_READS || found.length >= nodeHeartbeatBodyFoldersMax) break;
      reads++;
      let entries;
      try {
        entries = await readdir(rel === "" ? root : path.join(root, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      const names = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_FOLDERS.has(e.name) && FOLDER_SEGMENT.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        const child = rel === "" ? name : `${rel}/${name}`;
        if (child.length > nodeHeartbeatBodyFoldersItemMax) continue;
        if (found.length >= nodeHeartbeatBodyFoldersMax) break;
        found.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return found.sort((a, b) => a.localeCompare(b));
}
