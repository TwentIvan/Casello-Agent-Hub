import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, servicePath, type CliDeps } from "./cli";
import { defaultPaths } from "./config";
import { LABEL, plistPath, type LaunchctlRunner } from "./launchd";
import { writeState } from "./state";
import { FAKE_TOKEN, tempDir } from "./test/helpers";

let home: string;
let root: string;
let cleanup: () => Promise<void>;
let calls: string[][];
let loaded: boolean;
let printOut: string;
let out: string;
let err: string;

beforeEach(async () => {
  ({ dir: home, cleanup } = await tempDir("casello-cli-"));
  root = path.join(home, "spazi");
  await mkdir(root);
  calls = [];
  loaded = false;
  printOut = "";
  out = "";
  err = "";
});
afterEach(() => cleanup());

function deps(over: Partial<CliDeps> = {}): CliDeps {
  const launchctl: LaunchctlRunner = async (args) => {
    calls.push(args);
    if (args[0] === "print") return loaded ? { code: 0, stdout: printOut, stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "bootstrap") loaded = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    home,
    uid: 501,
    launchctl,
    execPath: "/opt/node/bin/node",
    entryPath: "/app/dist/index.mjs",
    whichClaude: async () => "/Users/x/.local/bin/claude",
    out: (t) => (out += t),
    err: (t) => (err += t),
    startLoop: vi.fn(() => ({ stop: async () => {} })) as unknown as CliDeps["startLoop"],
    onSignal: () => {},
    exit: () => {},
    ...over,
  };
}

const installArgs = () => ["install", "--url", "https://casello.example.com/", "--token", FAKE_TOKEN, "--workspace-root", root];

describe("install", () => {
  it("scrive la config 600 e il plist, poi bootstrap; il token non compare nell'output né nel plist", async () => {
    expect(await runCli(installArgs(), deps())).toBe(0);
    const paths = defaultPaths(home);
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toEqual({
      caselloUrl: "https://casello.example.com",
      token: FAKE_TOKEN,
      workspaceRoot: root,
    });
    const plist = await readFile(plistPath(home), "utf8");
    expect(plist).toContain("<string>/opt/node/bin/node</string>\n    <string>/app/dist/index.mjs</string>\n    <string>run</string>");
    expect(plist).toContain("/Users/x/.local/bin:");
    expect(plist).not.toContain(FAKE_TOKEN);
    expect(out + err).not.toContain(FAKE_TOKEN);
    expect(calls.at(-1)).toEqual(["bootstrap", "gui/501", plistPath(home)]);
  });

  it("un config esistente con permessi larghi torna 600", async () => {
    const paths = defaultPaths(home);
    await mkdir(path.dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, "{}", { mode: 0o644 });
    await chmod(paths.configPath, 0o644);
    expect(await runCli(installArgs(), deps())).toBe(0);
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
  });

  it("già caricato → bootout prima del bootstrap", async () => {
    loaded = true;
    await runCli(installArgs(), deps());
    expect(calls.map((c) => c[0])).toEqual(["print", "bootout", "bootstrap"]);
  });

  it("senza `claude` avvisa e usa i percorsi di ripiego", async () => {
    await runCli(installArgs(), deps({ whichClaude: async () => null }));
    expect(err).toContain("`claude` non trovato");
    const plist = await readFile(plistPath(home), "utf8");
    expect(plist).toContain("/usr/local/bin:/opt/homebrew/bin:" + path.join(home, ".local", "bin"));
  });

  it.each([
    ["url http", ["--url", "http://casello.example.com"]],
    ["url non valido", ["--url", "non-un-url"]],
    ["radice inesistente", ["--workspace-root", "/non/esiste/mai"]],
  ])("%s → errore e nulla scritto", async (_n, override) => {
    const args = [...installArgs()];
    const [flag, value] = override;
    args[args.indexOf(flag) + 1] = value;
    expect(await runCli(args, deps())).toBe(1);
    await expect(stat(defaultPaths(home).configPath)).rejects.toThrow();
    await expect(stat(plistPath(home))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("eseguibile non costruito (TS) → errore", async () => {
    expect(await runCli(installArgs(), deps({ entryPath: "/app/src/index.ts" }))).toBe(1);
    expect(err).toContain("non costruito");
    expect(calls).toEqual([]);
  });

  it("senza opzioni e senza terminale → errore; con terminale chiede i valori", async () => {
    expect(await runCli(["install"], deps())).toBe(1);
    const asked: Array<[string, boolean]> = [];
    const answers = ["https://casello.example.com", FAKE_TOKEN, root];
    const prompt = async (q: string, hidden: boolean) => {
      asked.push([q, hidden]);
      return answers.shift() ?? "";
    };
    expect(await runCli(["install"], deps({ prompt }))).toBe(0);
    expect(asked.map((a) => a[1])).toEqual([false, true, false]);
    expect(out).not.toContain(FAKE_TOKEN);
  });
});

describe("uninstall", () => {
  it("bootout, toglie il plist e lascia config e log", async () => {
    await runCli(installArgs(), deps());
    calls = [];
    out = "";
    expect(await runCli(["uninstall"], deps())).toBe(0);
    expect(calls.at(-1)).toEqual(["bootout", `gui/501/${LABEL}`]);
    await expect(stat(plistPath(home))).rejects.toThrow();
    expect((await stat(defaultPaths(home).configPath)).isFile()).toBe(true);
    expect(out).toContain(defaultPaths(home).configPath);
    expect(out).toContain(defaultPaths(home).logsDir);
  });
  it("servizio non caricato → nessun errore", async () => {
    expect(await runCli(["uninstall"], deps())).toBe(0);
  });
});

describe("status", () => {
  it("mostra launchd, ultimo heartbeat e compiti da state.json, senza token", async () => {
    loaded = true;
    printOut = "state = running\npid = 777";
    await writeState(defaultPaths(home).statePath, {
      pid: 777,
      updatedAt: "2026-11-04T10:00:00.000Z",
      lastHeartbeatAt: "2026-11-04T09:59:30.000Z",
      tasks: [{ taskId: 42, startedAt: "2026-11-04T09:50:00.000Z" }],
      lastError: null,
    });
    expect(await runCli(["status"], deps())).toBe(0);
    expect(out).toContain("in esecuzione (pid 777)");
    expect(out).toContain("2026-11-04T09:59:30.000Z");
    expect(out).toContain("#42");
    expect(calls).toEqual([["print", `gui/501/${LABEL}`]]);
  });
  it("servizio assente e nessuno stato", async () => {
    expect(await runCli(["status"], deps())).toBe(0);
    expect(out).toContain("non caricato");
    expect(out).toContain("nessun dato");
  });
});

describe("run", () => {
  async function writeConfig() {
    const p = defaultPaths(home);
    await mkdir(path.dirname(p.configPath), { recursive: true });
    await writeFile(p.configPath, JSON.stringify({ caselloUrl: "https://c.example.com", token: FAKE_TOKEN, workspaceRoot: root }), {
      mode: 0o600,
    });
    await chmod(p.configPath, 0o600);
  }

  it("SIGTERM → stop una volta e codice 0; il secondo segnale forza l'uscita 1", async () => {
    await writeConfig();
    const proc = new EventEmitter();
    const exit = vi.fn();
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => (release = r)));
    const d = deps({
      startLoop: vi.fn(() => ({ stop })) as unknown as CliDeps["startLoop"],
      onSignal: (s, h) => void proc.on(s, h),
      exit,
    });
    const result = runCli(["run"], d);
    await vi.waitFor(() => expect(proc.listenerCount("SIGTERM")).toBe(1));
    proc.emit("SIGTERM");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    proc.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stop).toHaveBeenCalledTimes(1);
    release();
    expect(await result).toBe(0);
  });

  it("config mancante → errore, il ciclo non parte", async () => {
    const d = deps();
    expect(await runCli(["run"], d)).toBe(1);
    expect(err).toContain("config non trovata");
    expect(d.startLoop).not.toHaveBeenCalled();
  });
});

describe("servicePath", () => {
  it("include la cartella di claude e quella di node", () => {
    const p = servicePath("/Users/x/.local/bin/claude", "/opt/node/bin/node", "/Users/x").split(":");
    expect(p.slice(0, 2)).toEqual(["/Users/x/.local/bin", "/opt/node/bin"]);
    expect(new Set(p).size).toBe(p.length);
  });
});

it("comando sconosciuto → uso e codice 1", async () => {
  expect(await runCli(["boh"], deps())).toBe(1);
  expect(err).toContain("uso:");
});
