import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPaths, type NodePaths } from "./config";
import { LABEL, plistPath, type LaunchctlRunner } from "./launchd";
import { LOG_FILE } from "./log";
import {
  buildDiagnostics,
  DIAGNOSTICS_MAX_BODY_BYTES,
  sendDiagnostics,
  UNINSTALLED_TEXT,
  uninstallSelf,
  type DiagnosticsDeps,
} from "./node-admin";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, tempDir, testConfig } from "./test/helpers";

let home: string;
let cleanup: () => Promise<void>;
let paths: NodePaths;
let casello: FakeCasello;

beforeEach(async () => {
  ({ dir: home, cleanup } = await tempDir("casello-admin-"));
  paths = defaultPaths(home);
  casello = new FakeCasello();
  await casello.start();
});
afterEach(async () => {
  await casello.close();
  await cleanup();
});

describe("diagnosi", () => {
  async function writeLog(lines: number, width = 20) {
    await mkdir(paths.logsDir, { recursive: true });
    const text = Array.from({ length: lines }, (_, i) => `riga ${i + 1} ${"x".repeat(width)}`).join("\n");
    await writeFile(path.join(paths.logsDir, LOG_FILE), `${text}\n`);
  }

  function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
    return {
      paths,
      config: testConfig({ caselloUrl: casello.url, workspaceRoot: path.join(home, "Botcave") }),
      version: "0.3.0",
      osVersion: async () => "15.1",
      claudeStatus: async () => ({ found: true, version: "2.1.0", loggedIn: true }),
      send: vi.fn(async () => {}),
      ...over,
    };
  }

  it("ultime 500 righe del log, state.json, config senza token, macOS, versione e Claude", async () => {
    await writeLog(600);
    await mkdir(path.dirname(paths.statePath), { recursive: true });
    await writeFile(paths.statePath, JSON.stringify({ pid: 1, lastError: "errore di prova" }));
    const content = await buildDiagnostics(deps());
    expect(content).not.toContain(FAKE_TOKEN);
    expect(content).toContain("riga 600 ");
    expect(content).toContain("riga 101 ");
    expect(content).not.toContain("riga 100 ");
    expect(content).toContain("errore di prova");
    expect(content).toContain("15.1");
    expect(content).toContain("0.3.0");
    expect(content).toContain("2.1.0");
    expect(content).toContain("bypassPermissions");
  });

  it("senza log, stato né Claude → testo comunque valido", async () => {
    const content = await buildDiagnostics(deps({ claudeStatus: async () => undefined, osVersion: async () => null }));
    expect(content).toContain("0.3.0");
    expect(content).not.toContain(FAKE_TOKEN);
  });

  it("log enorme → il corpo JSON resta entro 256 KB, tenendo le righe più recenti", async () => {
    await writeLog(500, 2_000);
    const content = await buildDiagnostics(deps());
    expect(Buffer.byteLength(JSON.stringify({ content }))).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BODY_BYTES);
    expect(content).toContain("riga 500 ");
  });

  it("il token non esce nemmeno se finisce nel log o nello stato", async () => {
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(path.join(paths.logsDir, LOG_FILE), `riga con ${FAKE_TOKEN}\n`);
    await writeFile(paths.statePath, JSON.stringify({ lastError: FAKE_TOKEN }));
    const send = vi.fn(async (_content: string) => {});
    await sendDiagnostics(deps({ send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).not.toContain(FAKE_TOKEN);
  });
});

describe("uninstallSelf", () => {
  let calls: string[][];
  let loaded: boolean;
  const launchctl: LaunchctlRunner = async (args) => {
    calls.push(args);
    if (args[0] === "print") return loaded ? { code: 0, stdout: "state = running", stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (args[0] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };

  beforeEach(async () => {
    calls = [];
    loaded = true;
    await mkdir(path.dirname(paths.configPath), { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({ caselloUrl: casello.url, token: FAKE_TOKEN, workspaceRoot: home }), { mode: 0o600 });
    await mkdir(path.dirname(paths.appProgramPath), { recursive: true });
    await writeFile(paths.appProgramPath, "programma");
    await writeFile(`${paths.appProgramPath}.prev`, "programma vecchio");
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(path.join(paths.logsDir, LOG_FILE), "log\n");
    await mkdir(path.dirname(plistPath(home)), { recursive: true });
    await writeFile(plistPath(home), "<plist/>");
  });

  function run(over: { appMode?: boolean; status?: number } = {}) {
    const order: string[] = [];
    casello.on("POST", "/api/node/uninstalled", (_req, res) => {
      order.push("server");
      json(res, over.status ?? 204);
    });
    const d = {
      home,
      uid: 501,
      launchctl: async (args: string[]) => {
        if (args[0] === "bootout") order.push("bootout");
        return launchctl(args);
      },
      appMode: over.appMode ?? true,
      stopLoop: vi.fn(async () => void order.push("stop")),
      notify: vi.fn(async (text: string) => void order.push(`notify:${text}`)),
      exit: vi.fn((code: number) => void order.push(`exit:${code}`)),
    };
    return { d, order, done: uninstallSelf(d) };
  }

  it("ferma il lavoro, avvisa Botcave, toglie servizio, programma e config; lascia i log; notifica ed esce", async () => {
    const { d, order, done } = run();
    await done;
    expect(order).toEqual(["stop", "server", `notify:${UNINSTALLED_TEXT}`, "bootout", "exit:0"]);
    const [req] = casello.calls("POST", "/api/node/uninstalled");
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(calls).toContainEqual(["bootout", `gui/501/${LABEL}`]);
    expect(existsSync(paths.configPath)).toBe(false);
    expect(existsSync(path.dirname(paths.appProgramPath))).toBe(false);
    expect(existsSync(plistPath(home))).toBe(false);
    expect(existsSync(path.join(paths.logsDir, LOG_FILE))).toBe(true);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("Botcave non risponde → la disinstallazione locale avviene comunque", async () => {
    const { order, done } = run({ status: 500 });
    await done;
    expect(order).toContain("bootout");
    expect(existsSync(paths.configPath)).toBe(false);
  });

  it("modalità CLI → nessuna notifica", async () => {
    const { d, done } = run({ appMode: false });
    await done;
    expect(d.notify).not.toHaveBeenCalled();
    expect(existsSync(paths.configPath)).toBe(false);
  });
});
