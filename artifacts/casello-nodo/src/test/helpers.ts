import { spawn as realSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config";
import type { TaskPackage } from "../client";

export const FAKE_TOKEN = "cas_segretissimo_del_nodo_0123456789";
const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");

export async function tempDir(prefix = "casello-nodo-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    caselloUrl: "http://127.0.0.1:1",
    token: FAKE_TOKEN,
    workspaceRoot: "/inesistente",
    claudeBin: "claude",
    permissionMode: "bypassPermissions",
    skillsDirs: [],
    maxConcurrent: 1,
    maxConcurrentTurns: 2,
    taskTimeoutMinutes: 60,
    ...over,
  };
}

export interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** `spawn` iniettato: al posto di `claude` esegue lo script finto nella modalità data. */
export function fakeSpawn(mode: string, calls: SpawnCall[] = [], extraEnv: Record<string, string> = {}) {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args: [...args], options });
    return realSpawn(process.execPath, [FAKE_CLAUDE, mode, ...args], {
      ...options,
      env: { ...options.env, ...extraEnv },
    });
  };
}

export function taskPackage(over: Partial<TaskPackage> = {}): TaskPackage {
  return {
    taskId: 42,
    leaseToken: "lease-abc",
    leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
    team: { id: 7, name: "Squadra prova", refType: "WI", refId: "1174", refTitle: "WI · 1174" },
    workspace: "progetto",
    role: { key: "dev", name: "Sviluppatore", task: "Scrive il codice", preferredModel: null },
    task: { planTaskId: "t1", title: "Primo compito", instructions: "ISTRUZIONI SEGRETE DEL COMPITO" },
    plan: {
      objective: "Obiettivo della squadra",
      constraints: ["vincolo uno"],
      openPoints: [],
      tasks: [{ id: "t1", title: "Primo compito", roleKey: "dev", status: "running", outcome: null }],
      manualActions: [{ id: "m1", text: "Creare il branch", done: true }],
    },
    caselloSkills: [{ code: "stile", version: 2, content: "Scrivi in modo chiaro." }],
    nodeSkills: ["sap-code-review"],
    attachments: [],
    ...over,
  };
}
