import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAppExecPath, launchArgs, MENU_ITEMS, runAppMode, type AppDeps, type ClaudeActions } from "./app-mode";
import type { PairingClient, PollResult } from "./client";
import { appBaseUrl, DEFAULT_URL, defaultPaths } from "./config";
import { escapeAppleScript, osascriptDialogs, type Dialogs, type ExecFileLike } from "./dialogs";
import { LABEL, plistPath, type LaunchctlRunner } from "./launchd";
import { FAKE_TOKEN, tempDir } from "./test/helpers";

let home: string;
let cleanup: () => Promise<void>;
let programSource: string;
let calls: string[][];
let loaded: boolean;
let log: string[];
let opened: string[];
let fetched: Array<{ url: string; auth: string | null }>;

beforeEach(async () => {
  ({ dir: home, cleanup } = await tempDir("casello-app-"));
  programSource = path.join(home, "Applications", "Botcave Nodo.app", "Contents", "MacOS", "botcave-nodo");
  await mkdir(path.dirname(programSource), { recursive: true });
  await writeFile(programSource, "eseguibile v1\n");
  calls = [];
  loaded = false;
  log = [];
  opened = [];
  fetched = [];
});
afterEach(() => cleanup());

const launchctl: LaunchctlRunner = async (args) => {
  calls.push(args);
  if (args[0] === "print") return loaded ? { code: 0, stdout: "state = running", stderr: "" } : { code: 113, stdout: "", stderr: "" };
  if (args[0] === "bootout") loaded = false;
  if (args[0] === "bootstrap") loaded = true;
  return { code: 0, stdout: "", stderr: "" };
};

interface DialogScript {
  folder?: string | null;
  menu?: string | null;
  confirm?: boolean;
}

function dialogs(script: DialogScript = {}): Dialogs {
  return {
    alert: async (t) => void log.push(`alert:${t}`),
    notify: async (title, t) => void log.push(`notify:${title}:${t}`),
    chooseFolder: async (prompt, def) => {
      log.push(`folder:${def}`);
      return script.folder ?? null;
    },
    chooseFromList: async (_p, items) => {
      log.push(`menu:${items.join("|")}`);
      return script.menu ?? null;
    },
    confirm: async (t) => {
      log.push(`confirm:${t}`);
      return script.confirm ?? false;
    },
  };
}

function pairingClient(token = FAKE_TOKEN, name = "MacBook di Ivan"): PairingClient {
  const results: PollResult[] = [
    { status: "pending" },
    { status: "pending" },
    { status: "approved", token, nodeId: 9, nodeName: name },
  ];
  return {
    start: async (body) => {
      log.push(`start:${body.deviceName}:${body.version}`);
      return { pairingId: "p1", userCode: "ABCD-EFGH", pollSecret: "s", expiresAt: new Date(Date.now() + 600_000) };
    },
    poll: async () => results.shift() ?? { status: "gone" },
  };
}

const claudeCalls: string[] = [];
function claude(found = true): ClaudeActions {
  return {
    found: async () => found,
    install: async () => void claudeCalls.push("install"),
    login: async () => void claudeCalls.push("login"),
  };
}

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    home,
    uid: 501,
    launchctl,
    dialogs: dialogs(),
    openUrl: async (u) => void opened.push(u),
    sleep: async () => {},
    caselloUrl: "https://casello.example.com",
    pairingClient: () => pairingClient(),
    programSource,
    deviceName: async () => "MacBook di Ivan",
    version: "0.3.0",
    whichClaude: async () => "/Users/x/.local/bin/claude",
    claude: claude(),
    removeQuarantine: async () => {},
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    ...over,
  };
}

async function writeConfig(content: Record<string, unknown>) {
  const p = defaultPaths(home).configPath;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
}

async function readConfig() {
  return JSON.parse(await readFile(defaultPaths(home).configPath, "utf8")) as Record<string, unknown>;
}

describe("primo avvio senza config", () => {
  it("abbina, usa ~/Botcave se il selettore è annullato, installa programma e LaunchAgent", async () => {
    expect(await runAppMode(deps())).toBe(0);
    expect(log[0]).toBe("start:MacBook di Ivan:0.3.0");
    expect(opened).toEqual(["https://casello.example.com/nodes/pair?code=ABCD-EFGH"]);
    expect(log.some((l) => l.startsWith("notify:") && l.includes("ABCD-EFGH"))).toBe(true);
    const botcave = path.join(home, "Botcave");
    expect(log).toContain(`folder:${botcave}`);
    expect((await stat(botcave)).isDirectory()).toBe(true);

    const paths = defaultPaths(home);
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    expect(await readConfig()).toEqual({ caselloUrl: "https://casello.example.com", token: FAKE_TOKEN, workspaceRoot: botcave });

    const program = paths.appProgramPath;
    expect(program).toBe(path.join(home, ".casello-nodo", "bin", "casello-nodo"));
    expect(await readFile(program, "utf8")).toBe("eseguibile v1\n");
    expect((await stat(program)).mode & 0o777).toBe(0o755);

    const plist = await readFile(plistPath(home), "utf8");
    expect(plist).toContain(`<array>\n    <string>${program}</string>\n    <string>run</string>\n  </array>`);
    expect(plist).not.toContain(FAKE_TOKEN);
    expect(calls.some((c) => c[0] === "bootstrap")).toBe(true);
    expect(log.at(-1)).toBe("alert:Botcave Nodo è collegato come «MacBook di Ivan»");
  });

  it("toglie la quarantena dalla copia temporanea prima del rename; un errore non ferma l'installazione", async () => {
    const program = defaultPaths(home).appProgramPath;
    const seen: Array<{ file: string; tmpExists: boolean; programExists: boolean }> = [];
    const exists = (p: string) => stat(p).then(() => true, () => false);
    const removeQuarantine = async (file: string) => {
      seen.push({ file, tmpExists: await exists(file), programExists: await exists(program) });
      throw new Error("xattr: No such xattr: com.apple.quarantine");
    };
    expect(await runAppMode(deps({ removeQuarantine }))).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.file).toBe(`${program}.${process.pid}.tmp`);
    expect(seen[0]).toMatchObject({ tmpExists: true, programExists: false });
    expect(await readFile(program, "utf8")).toBe("eseguibile v1\n");
    expect(calls.some((c) => c[0] === "bootstrap")).toBe(true);
  });

  it("cartella scelta → workspaceRoot è quella", async () => {
    const chosen = path.join(home, "Lavoro");
    await mkdir(chosen);
    expect(await runAppMode(deps({ dialogs: dialogs({ folder: chosen }) }))).toBe(0);
    expect((await readConfig()).workspaceRoot).toBe(chosen);
  });

  it("abbinamento scaduto → uscita 1, niente installato", async () => {
    const client: PairingClient = {
      start: async () => ({ pairingId: "p", userCode: "ABCD-EFGH", pollSecret: "s", expiresAt: new Date(Date.now() + 600_000) }),
      poll: async () => ({ status: "gone" }),
    };
    expect(await runAppMode(deps({ pairingClient: () => client }))).toBe(1);
    await expect(stat(defaultPaths(home).configPath)).rejects.toThrow();
    expect(calls.some((c) => c[0] === "bootstrap")).toBe(false);
  });

  it("copia del programma non riuscita dopo l'abbinamento → config con il token salvata; riaprendo si adotta senza start", async () => {
    const missing = path.join(home, "inesistente", "botcave-nodo");
    expect(await runAppMode(deps({ programSource: missing }))).toBe(1);
    expect(await readConfig()).toEqual({
      caselloUrl: "https://casello.example.com",
      token: FAKE_TOKEN,
      workspaceRoot: path.join(home, "Botcave"),
    });
    expect((await stat(defaultPaths(home).configPath)).mode & 0o777).toBe(0o600);
    await expect(stat(defaultPaths(home).appProgramPath)).rejects.toThrow();
    expect(calls.some((c) => c[0] === "bootstrap")).toBe(false);
    expect(log.at(-1)).toBe("alert:Operazione non riuscita: riprova; se si ripete, apri i log dal menu di Botcave Nodo");

    let started = false;
    const reopen = await runAppMode(
      deps({
        pairingClient: () => ({
          start: async () => {
            started = true;
            throw new Error("non doveva partire");
          },
          poll: async () => ({ status: "gone" }),
        }),
      }),
    );
    expect(reopen).toBe(0);
    expect(started).toBe(false);
    expect(await readFile(defaultPaths(home).appProgramPath, "utf8")).toBe("eseguibile v1\n");
    expect((await readConfig()).token).toBe(FAKE_TOKEN);
    expect(calls.some((c) => c[0] === "bootstrap")).toBe(true);
  });

  it("Botcave non raggiungibile all'avvio dell'abbinamento → dialogo ed uscita 1", async () => {
    const client: PairingClient = {
      start: async () => {
        throw new Error("rete");
      },
      poll: async () => ({ status: "gone" }),
    };
    expect(await runAppMode(deps({ pairingClient: () => client }))).toBe(1);
    expect(log).toContain("alert:Botcave non raggiungibile: controlla la connessione e riapri Botcave Nodo");
  });
});

describe("config della CLI presente", () => {
  it("la adotta: nessun abbinamento, programma e LaunchAgent sostituiti, config invariata", async () => {
    const root = path.join(home, "spazi");
    await mkdir(root);
    const cfg = { caselloUrl: "https://casello.example.com", token: FAKE_TOKEN, workspaceRoot: root, maxConcurrent: 2 };
    await writeConfig(cfg);
    const before = await readFile(defaultPaths(home).configPath, "utf8");
    const oldProgram = defaultPaths(home).programPath;
    await mkdir(path.dirname(oldProgram), { recursive: true });
    await writeFile(oldProgram, "vecchio .mjs\n");
    loaded = true;
    let started = false;
    const client = pairingClient();
    expect(
      await runAppMode(
        deps({
          pairingClient: () => ({
            ...client,
            start: async (b) => {
              started = true;
              return client.start(b);
            },
          }),
        }),
      ),
    ).toBe(0);
    expect(started).toBe(false);
    expect(await readFile(defaultPaths(home).configPath, "utf8")).toBe(before);
    expect(await readFile(defaultPaths(home).appProgramPath, "utf8")).toBe("eseguibile v1\n");
    await expect(stat(oldProgram)).rejects.toThrow();
    const plist = await readFile(plistPath(home), "utf8");
    expect(plist).toContain(`<string>${defaultPaths(home).appProgramPath}</string>\n    <string>run</string>`);
    expect(calls.map((c) => c[0])).toEqual(expect.arrayContaining(["bootout", "bootstrap"]));
    expect(log.some((l) => l.startsWith("alert:"))).toBe(true);
    expect(log.some((l) => l.startsWith("menu:"))).toBe(false);
  });
});

describe("collegato: menu", () => {
  let root: string;
  beforeEach(async () => {
    root = path.join(home, "spazi");
    await mkdir(root);
    await writeConfig({ caselloUrl: "https://casello.example.com", token: FAKE_TOKEN, workspaceRoot: root, maxConcurrent: 2 });
    const program = defaultPaths(home).appProgramPath;
    await mkdir(path.dirname(program), { recursive: true });
    await writeFile(program, "installato\n", { mode: 0o755 });
    loaded = true;
    claudeCalls.length = 0;
  });

  it("voci nell'ordine della spec; «Installa Claude Code» solo se manca", async () => {
    await runAppMode(deps());
    expect(log).toContain(`menu:${MENU_ITEMS.filter((i) => i !== "Installa Claude Code").join("|")}`);
    log = [];
    await runAppMode(deps({ claude: claude(false) }));
    expect(log).toContain(
      "menu:Apri Botcave|Installa Claude Code|Accedi a Claude|Cambia cartella di lavoro|Apri i log|Ricollega|Disinstalla",
    );
  });

  it("menu annullato → uscita 0 senza effetti", async () => {
    const before = await readFile(defaultPaths(home).configPath, "utf8");
    expect(await runAppMode(deps())).toBe(0);
    expect(calls.filter((c) => c[0] !== "print")).toEqual([]);
    expect(opened).toEqual([]);
    expect(await readFile(defaultPaths(home).configPath, "utf8")).toBe(before);
  });

  it("«Cambia cartella di lavoro» → workspaceRoot aggiornato, altri campi intatti, kickstart -k", async () => {
    const other = path.join(home, "altro");
    await mkdir(other);
    expect(await runAppMode(deps({ dialogs: dialogs({ menu: "Cambia cartella di lavoro", folder: other }) }))).toBe(0);
    expect(log).toContain(`folder:${root}`);
    const cfg = await readConfig();
    expect(cfg.workspaceRoot).toBe(other);
    expect(cfg.maxConcurrent).toBe(2);
    expect(cfg.token).toBe(FAKE_TOKEN);
    expect((await stat(defaultPaths(home).configPath)).mode & 0o777).toBe(0o600);
    expect(calls).toContainEqual(["kickstart", "-k", `gui/501/${LABEL}`]);
  });

  it("«Cambia cartella di lavoro» annullato → niente cambia", async () => {
    const before = await readFile(defaultPaths(home).configPath, "utf8");
    expect(await runAppMode(deps({ dialogs: dialogs({ menu: "Cambia cartella di lavoro", folder: null }) }))).toBe(0);
    expect(await readFile(defaultPaths(home).configPath, "utf8")).toBe(before);
    expect(calls.some((c) => c[0] === "kickstart")).toBe(false);
  });

  it("«Ricollega» → nuovo abbinamento e token sostituito nella config", async () => {
    const d = deps({ dialogs: dialogs({ menu: "Ricollega" }), pairingClient: () => pairingClient("cas_token_nuovo_9876543210", "Mac nuovo") });
    expect(await runAppMode(d)).toBe(0);
    const cfg = await readConfig();
    expect(cfg.token).toBe("cas_token_nuovo_9876543210");
    expect(cfg.workspaceRoot).toBe(root);
    expect(cfg.maxConcurrent).toBe(2);
    expect(calls).toContainEqual(["kickstart", "-k", `gui/501/${LABEL}`]);
    expect(log.at(-1)).toBe("alert:Botcave Nodo è collegato come «Mac nuovo»");
  });

  it("«Apri Botcave» e «Apri i log» usano open", async () => {
    await runAppMode(deps({ dialogs: dialogs({ menu: "Apri Botcave" }) }));
    await runAppMode(deps({ dialogs: dialogs({ menu: "Apri i log" }) }));
    expect(opened).toEqual(["https://casello.example.com/account", defaultPaths(home).logsDir]);
  });

  it("voci di Claude → ClaudeActions", async () => {
    await runAppMode(deps({ claude: claude(false), dialogs: dialogs({ menu: "Installa Claude Code" }) }));
    await runAppMode(deps({ dialogs: dialogs({ menu: "Accedi a Claude" }) }));
    expect(claudeCalls).toEqual(["install", "login"]);
  });

  it("«Disinstalla» con conferma → bootout, programma e config tolti, log restano", async () => {
    const paths = defaultPaths(home);
    await mkdir(paths.logsDir, { recursive: true });
    expect(await runAppMode(deps({ dialogs: dialogs({ menu: "Disinstalla", confirm: true }) }))).toBe(0);
    expect(calls).toContainEqual(["bootout", `gui/501/${LABEL}`]);
    await expect(stat(plistPath(home))).rejects.toThrow();
    await expect(stat(path.dirname(paths.appProgramPath))).rejects.toThrow();
    await expect(stat(paths.configPath)).rejects.toThrow();
    expect((await stat(paths.logsDir)).isDirectory()).toBe(true);
    expect(log).toContain("notify:Botcave Nodo:Botcave Nodo è stato rimosso. Puoi spostare l'app nel cestino.");
    // Botcave disattiva il nodo
    expect(fetched).toEqual([{ url: "https://casello.example.com/api/node/uninstalled", auth: `Bearer ${FAKE_TOKEN}` }]);
  });

  it("«Disinstalla» con Botcave non raggiungibile → la disinstallazione locale avviene comunque", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await runAppMode(deps({ fetch: failing, dialogs: dialogs({ menu: "Disinstalla", confirm: true }) }))).toBe(0);
    await expect(stat(defaultPaths(home).configPath)).rejects.toThrow();
    expect(calls).toContainEqual(["bootout", `gui/501/${LABEL}`]);
  });

  it("«Disinstalla» senza conferma → niente cambia", async () => {
    expect(await runAppMode(deps({ dialogs: dialogs({ menu: "Disinstalla", confirm: false }) }))).toBe(0);
    expect(calls.some((c) => c[0] === "bootout")).toBe(false);
    expect((await stat(defaultPaths(home).configPath)).isFile()).toBe(true);
    expect(fetched).toEqual([]);
  });
});

describe("osascriptDialogs", () => {
  type Call = { file: string; args: string[] };
  function fakeExec(result: { code?: number; stdout?: string; stderr?: string }, seen: Call[] = []): ExecFileLike {
    return (file, args, cb) => {
      seen.push({ file, args });
      if (result.code) {
        const err = Object.assign(new Error("Command failed"), { code: result.code });
        cb(err, result.stdout ?? "", result.stderr ?? "");
      } else cb(null, result.stdout ?? "", result.stderr ?? "");
    };
  }
  const canceled = { code: 1, stderr: "execution error: User canceled. (-128)\n" };

  it("annullato → null / false", async () => {
    const d = osascriptDialogs(fakeExec(canceled));
    expect(await d.chooseFolder("Scegli", "/Users/x/Botcave")).toBeNull();
    expect(await d.confirm("Sicuro?", "Disinstalla")).toBe(false);
    expect(await d.chooseFromList("Menu", ["a"])).toBeNull();
  });

  it("choose from list annullato restituisce «false» → null", async () => {
    const d = osascriptDialogs(fakeExec({ stdout: "false\n" }));
    expect(await d.chooseFromList("Menu", ["Apri Botcave"])).toBeNull();
  });

  it("risultati: cartella senza barra finale, voce scelta, conferma", async () => {
    expect(await osascriptDialogs(fakeExec({ stdout: "/Users/x/Lavoro/\n" })).chooseFolder("p", "/Users/x")).toBe("/Users/x/Lavoro");
    expect(await osascriptDialogs(fakeExec({ stdout: "Ricollega\n" })).chooseFromList("p", ["Apri Botcave", "Ricollega"])).toBe(
      "Ricollega",
    );
    expect(await osascriptDialogs(fakeExec({ stdout: "button returned:Disinstalla\n" })).confirm("t", "Disinstalla")).toBe(true);
  });

  it("altri errori → eccezione", async () => {
    const d = osascriptDialogs(fakeExec({ code: 1, stderr: "execution error: qualcos'altro (-1700)" }));
    await expect(d.chooseFolder("p", "/x")).rejects.toThrow();
    await expect(d.alert("x")).rejects.toThrow();
  });

  it("i testi sono escapati: niente iniezione AppleScript, solo osascript -e", async () => {
    const seen: Call[] = [];
    const d = osascriptDialogs(fakeExec({ stdout: "" }, seen));
    const hostile = 'ciao" & (do shell script "rm -rf ~") & "\\';
    await d.alert(hostile);
    await d.notify(hostile, hostile);
    await d.chooseFolder(hostile, `/tmp/${hostile}`);
    await d.chooseFromList(hostile, [hostile]);
    await d.confirm(hostile, hostile);
    const escaped = escapeAppleScript(hostile);
    expect(escaped).toBe('ciao\\" & (do shell script \\"rm -rf ~\\") & \\"\\\\');
    for (const c of seen) {
      expect(c.file).toBe("/usr/bin/osascript");
      for (let i = 0; i < c.args.length; i += 2) expect(c.args[i]).toBe("-e");
      const script = c.args.filter((_, i) => i % 2 === 1).join("\n");
      expect(script).toContain(escaped);
      // Tolte le sequenze escapate, nessuna virgoletta del testo ostile resta libera
      const unescaped = script.replace(/\\\\/g, "").replace(/\\"/g, "");
      expect(unescaped).not.toContain("do shell script \"");
    }
  });
});

describe("modalità e indirizzo", () => {
  it("launchArgs toglie -psn_ del Finder e lascia gli altri argomenti", () => {
    expect(launchArgs(["-psn_0_12345"])).toEqual([]);
    expect(launchArgs([])).toEqual([]);
    expect(launchArgs(["-psn_0_1", "run"])).toEqual(["run"]);
    expect(launchArgs(["--version"])).toEqual(["--version"]);
  });
  it("isAppExecPath", () => {
    expect(isAppExecPath("/Applications/Botcave Nodo.app/Contents/MacOS/botcave-nodo")).toBe(true);
    expect(isAppExecPath("/opt/homebrew/bin/node")).toBe(false);
  });
  it("appBaseUrl: predefinito, BOTCAVE_NODO_URL solo se valido", () => {
    expect(DEFAULT_URL).toBe("https://casello.fantamister.cloud");
    expect(appBaseUrl({})).toBe(DEFAULT_URL);
    expect(appBaseUrl({ BOTCAVE_NODO_URL: "http://localhost:5173/" })).toBe("http://localhost:5173");
    expect(appBaseUrl({ BOTCAVE_NODO_URL: "http://evil.example.com" })).toBe(DEFAULT_URL);
    expect(appBaseUrl({ BOTCAVE_NODO_URL: "non un url" })).toBe(DEFAULT_URL);
  });
});
