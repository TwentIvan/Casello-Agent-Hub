import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultPaths, loadConfig } from "./config";
import { tempDir } from "./test/helpers";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => cleanup());

async function writeConfig(content: unknown, mode = 0o600): Promise<string> {
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(content));
  await chmod(file, mode);
  return file;
}

describe("loadConfig", () => {
  it("applica i valori predefiniti della spec", async () => {
    const file = await writeConfig({ caselloUrl: "https://casello.example", token: "cas_x", workspaceRoot: "/tmp/ws" });
    const config = loadConfig(file, { home: "/Users/prova" });
    expect(config).toEqual({
      caselloUrl: "https://casello.example",
      token: "cas_x",
      workspaceRoot: "/tmp/ws",
      claudeBin: "claude",
      permissionMode: "bypassPermissions",
      skillsDirs: ["/Users/prova/.claude/skills", "/Users/prova/.claude/plugins/cache"],
      maxConcurrent: 1,
      taskTimeoutMinutes: 60,
    });
  });

  it("espande ~ nei percorsi", async () => {
    const file = await writeConfig({
      caselloUrl: "https://casello.example",
      token: "cas_x",
      workspaceRoot: "~/Lavori",
      skillsDirs: ["~/skill"],
      maxConcurrent: 3,
    });
    const config = loadConfig(file, { home: "/Users/prova" });
    expect(config.workspaceRoot).toBe("/Users/prova/Lavori");
    expect(config.skillsDirs).toEqual(["/Users/prova/skill"]);
    expect(config.maxConcurrent).toBe(3);
  });

  it("rifiuta una config con permessi 644", async () => {
    const file = await writeConfig({ caselloUrl: "https://c", token: "cas_x", workspaceRoot: "/tmp" }, 0o644);
    expect(() => loadConfig(file)).toThrow(new ConfigError("config leggibile da altri: chmod 600"));
  });

  it("rifiuta valori fuori dai limiti", async () => {
    const file = await writeConfig({
      caselloUrl: "https://c",
      token: "cas_x",
      workspaceRoot: "/tmp",
      maxConcurrent: 4,
    });
    expect(() => loadConfig(file)).toThrow(ConfigError);
  });

  it("non riporta il token nel messaggio d'errore", async () => {
    const file = await writeConfig({ caselloUrl: 12, token: "cas_segreto", workspaceRoot: "/tmp" });
    try {
      loadConfig(file);
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("cas_segreto");
    }
  });

  it("file mancante → errore chiaro", () => {
    expect(() => loadConfig(path.join(dir, "manca.json"))).toThrow(ConfigError);
  });

  it("percorsi predefiniti sotto ~/.casello-nodo", () => {
    expect(defaultPaths("/Users/prova")).toEqual({
      configPath: "/Users/prova/.casello-nodo/config.json",
      logsDir: "/Users/prova/.casello-nodo/logs",
      statePath: "/Users/prova/.casello-nodo/state.json",
    });
  });
});
