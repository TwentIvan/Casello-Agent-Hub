import { EventEmitter } from "node:events";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NODE_VERSION } from "./capabilities";
import { runCli, servicePath, type CliDeps } from "./cli";
import { defaultPaths } from "./config";
import { LABEL, plistPath, type LaunchctlRunner } from "./launchd";
import { writeState } from "./state";
import { updatePaths } from "./updater";
import { FAKE_TOKEN, tempDir } from "./test/helpers";

let home: string;
let root: string;
let entry: string;
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
  // Programma costruito finto, fuori da ~/.casello-nodo (come dist/ nel repository)
  entry = path.join(home, "repo", "dist", "index.mjs");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "#!/usr/bin/env node\n// v1\n");
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
    entryPath: entry,
    whichClaude: async () => "/Users/x/.local/bin/claude",
    out: (t) => (out += t),
    err: (t) => (err += t),
    startLoop: vi.fn(() => ({ stop: async () => {}, crash: () => {} })) as unknown as CliDeps["startLoop"],
    onSignal: () => {},
    onFatal: () => {},
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
    const program = defaultPaths(home).programPath;
    expect(plist).toContain(`<string>/opt/node/bin/node</string>\n    <string>${program}</string>\n    <string>run</string>`);
    expect(plist).not.toContain(entry);
    expect(plist).toContain("/Users/x/.local/bin:");
    expect(plist).not.toContain(FAKE_TOKEN);
    expect(out + err).not.toContain(FAKE_TOKEN);
    expect(calls.at(-1)).toEqual(["bootstrap", "gui/501", plistPath(home)]);
  });

  it("copia il programma in ~/.casello-nodo/bin: il servizio non dipende dalla cartella in cui è stato costruito", async () => {
    expect(await runCli(installArgs(), deps())).toBe(0);
    const program = defaultPaths(home).programPath;
    expect(program).toBe(path.join(home, ".casello-nodo", "bin", "casello-nodo.mjs"));
    expect(await readFile(program, "utf8")).toBe(await readFile(entry, "utf8"));
    expect((await stat(program)).mode & 0o777).toBe(0o755);
    expect((await stat(path.dirname(program))).mode & 0o777).toBe(0o700);
    expect(out).toContain(`Programma: ${program}`);
    // Il repository sparisce: la copia resta
    await rm(path.join(home, "repo"), { recursive: true });
    expect((await stat(program)).isFile()).toBe(true);
  });

  it("reinstallare sostituisce la copia con la build nuova, senza file temporanei", async () => {
    expect(await runCli(installArgs(), deps())).toBe(0);
    await writeFile(entry, "#!/usr/bin/env node\n// v2\n");
    expect(await runCli(installArgs(), deps())).toBe(0);
    const program = defaultPaths(home).programPath;
    expect(await readFile(program, "utf8")).toContain("v2");
    expect((await readdir(path.dirname(program))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("install lanciato dalla copia stessa non la copia su sé stessa", async () => {
    expect(await runCli(installArgs(), deps())).toBe(0);
    const program = defaultPaths(home).programPath;
    expect(await runCli(installArgs(), deps({ entryPath: program }))).toBe(0);
    expect(await readFile(program, "utf8")).toContain("v1");
  });

  it("programma costruito illeggibile → errore, nessuna config né servizio", async () => {
    expect(await runCli(installArgs(), deps({ entryPath: path.join(home, "repo", "dist", "manca.mjs") }))).toBe(1);
    expect(err).toContain("copia del programma non riuscita");
    await expect(stat(defaultPaths(home).configPath)).rejects.toThrow();
    await expect(stat(plistPath(home))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("un config esistente con permessi larghi torna 600", async () => {
    const paths = defaultPaths(home);
    await mkdir(path.dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, "{}", { mode: 0o644 });
    await chmod(paths.configPath, 0o644);
    expect(await runCli(installArgs(), deps())).toBe(0);
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
  });

  it("il token non passa dal file preesistente 644: la config è un file nuovo (rename) e la cartella torna 700", async () => {
    const paths = defaultPaths(home);
    const dir = path.dirname(paths.configPath);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o755);
    await writeFile(paths.configPath, "vecchio", { mode: 0o644 });
    await chmod(paths.configPath, 0o644);
    const before = (await stat(paths.configPath)).ino;
    expect(await runCli(installArgs(), deps())).toBe(0);
    expect((await stat(paths.configPath)).ino).not.toBe(before);
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("--token-file legge il token e lo ripulisce; insieme a --token → errore", async () => {
    const file = path.join(home, "token.txt");
    await writeFile(file, `  ${FAKE_TOKEN}\n`);
    const args = ["install", "--url", "https://c.example.com", "--token-file", file, "--workspace-root", root];
    expect(await runCli(args, deps())).toBe(0);
    expect(JSON.parse(await readFile(defaultPaths(home).configPath, "utf8")).token).toBe(FAKE_TOKEN);
    expect(await runCli([...args, "--token", "x"], deps())).toBe(1);
    expect(await runCli(["install", "--token-file", path.join(home, "no.txt"), "--url", "https://c.example.com", "--workspace-root", root], deps())).toBe(1);
  });

  it("opzione sconosciuta → uso in italiano, nulla scritto", async () => {
    expect(await runCli(["install", "--pippo"], deps())).toBe(1);
    expect(err).toContain("opzioni non valide");
    expect(err).toContain("uso: casello-nodo install");
    expect(calls).toEqual([]);
  });

  it("bootstrap fallito → messaggio italiano con il codice di uscita", async () => {
    const d = deps();
    const base = d.launchctl;
    d.launchctl = async (a) => (a[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Input/output error" } : base(a));
    expect(await runCli(installArgs(), d)).toBe(1);
    expect(err).toContain("installazione non riuscita");
    expect(err).toContain("codice 5");
  });

  it("già caricato → bootout prima del bootstrap", async () => {
    loaded = true;
    await runCli(installArgs(), deps());
    expect(calls.map((c) => c[0])).toEqual(["print", "bootout", "print", "bootstrap"]);
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

describe("--version", () => {
  it("stampa solo la versione del nodo, senza toccare launchd", async () => {
    expect(await runCli(["--version"], deps())).toBe(0);
    expect(out).toBe(`${NODE_VERSION}\n`);
    expect(calls).toEqual([]);
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
    await expect(stat(path.dirname(defaultPaths(home).programPath))).rejects.toThrow();
    expect(out).toContain("programma rimosso");
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
      turns: [{ turnId: 9, startedAt: "2026-11-04T09:58:00.000Z" }],
      lastError: null,
    });
    expect(await runCli(["status"], deps())).toBe(0);
    expect(out).toContain("Turni in corso: #9");
    expect(out).toContain("in esecuzione (pid 777)");
    expect(out).toContain("2026-11-04T09:59:30.000Z");
    expect(out).toContain("#42");
    expect(calls).toEqual([["print", `gui/501/${LABEL}`]]);
  });
  it("heartbeat vecchio di oltre 2 minuti → «nessun contatto da N minuti»", async () => {
    await writeState(defaultPaths(home).statePath, {
      pid: 1,
      updatedAt: "2026-11-04T10:00:00.000Z",
      lastHeartbeatAt: "2026-11-04T10:00:00.000Z",
      tasks: [],
      lastError: null,
    });
    await runCli(["status"], deps({ now: () => new Date("2026-11-04T10:07:30.000Z") }));
    expect(out).toContain("nessun contatto da 7 minuti");
    out = "";
    await runCli(["status"], deps({ now: () => new Date("2026-11-04T10:01:00.000Z") }));
    expect(out).not.toContain("nessun contatto");
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

  it("eccezione non gestita → compiti interrotti subito (crash) e uscita 1", async () => {
    await writeConfig();
    const exit = vi.fn();
    const crash = vi.fn();
    let fatal: ((err: unknown) => void) | undefined;
    const d = deps({
      startLoop: vi.fn(() => ({ stop: vi.fn(), crash })) as unknown as CliDeps["startLoop"],
      onFatal: (h) => {
        fatal = h;
      },
      exit,
    });
    void runCli(["run"], d);
    await vi.waitFor(() => expect(fatal).toBeDefined());
    const boom = new Error("boom");
    fatal!(boom);
    expect(crash).toHaveBeenCalledWith(boom);
    expect(exit).toHaveBeenCalledWith(1);
    expect(crash.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
  });

  it("kind: «app» se il programma in esecuzione è la copia dell'app, altrimenti «cli»", async () => {
    await writeConfig();
    const startLoop = vi.fn(() => ({ stop: async () => {}, crash: () => {} })) as unknown as CliDeps["startLoop"];
    void runCli(["run"], deps({ startLoop, execPath: defaultPaths(home).appProgramPath }));
    await vi.waitFor(() => expect(startLoop).toHaveBeenCalledTimes(1));
    expect((startLoop as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ kind: "app" });
    const cliLoop = vi.fn(() => ({ stop: async () => {}, crash: () => {} })) as unknown as CliDeps["startLoop"];
    void runCli(["run"], deps({ startLoop: cliLoop }));
    await vi.waitFor(() => expect(cliLoop).toHaveBeenCalledTimes(1));
    expect((cliLoop as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ kind: "cli" });
  });

  it("terzo avvio entro 2 minuti da un aggiornamento → ripristina la versione precedente ed esce senza avviare il ciclo", async () => {
    await writeConfig();
    const upd = updatePaths(home);
    await mkdir(path.dirname(upd.programPath), { recursive: true });
    await writeFile(upd.programPath, "nuovo");
    await writeFile(upd.prevPath, "vecchio");
    const startedAt = new Date("2026-11-10T10:00:00.000Z");
    await writeFile(upd.updateJsonPath, JSON.stringify({ from: "0.3.0", to: "0.4.0", startedAt: startedAt.toISOString(), starts: 2 }));
    const d = deps({ now: () => new Date(startedAt.getTime() + 60_000) });
    expect(await runCli(["run"], d)).toBe(1);
    expect(d.startLoop).not.toHaveBeenCalled();
    expect(await readFile(upd.programPath, "utf8")).toBe("vecchio");
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
