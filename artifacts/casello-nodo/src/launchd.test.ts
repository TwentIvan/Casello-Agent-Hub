import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPlist,
  installService,
  LABEL,
  plistPath,
  serviceStatus,
  uninstallService,
  type LaunchctlResult,
  type LaunchctlRunner,
} from "./launchd";
import { tempDir } from "./test/helpers";

let home: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir: home, cleanup } = await tempDir("casello-launchd-"));
});
afterEach(() => cleanup());

function fakeLaunchctl(loaded: boolean, printOut = ""): { run: LaunchctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  let isLoaded = loaded;
  const run: LaunchctlRunner = async (args): Promise<LaunchctlResult> => {
    calls.push(args);
    if (args[0] === "print") return isLoaded ? { code: 0, stdout: printOut, stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (args[0] === "bootout") isLoaded = false;
    if (args[0] === "bootstrap") isLoaded = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("buildPlist", () => {
  const plist = buildPlist({
    programArguments: ["/usr/bin/node", "/app/dist/index.mjs", "run"],
    logsDir: "/Users/x/.casello-nodo/logs",
    path: "/opt/homebrew/bin:/usr/bin",
  });
  it("ha label, argomenti, avvio al login, riavvio e log", () => {
    expect(plist).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`);
    expect(plist).toContain("<string>/usr/bin/node</string>\n    <string>/app/dist/index.mjs</string>\n    <string>run</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    // Allo stop launchd aspetta 30 s prima del SIGKILL: il nodo termina i gruppi di `claude` e riferisce
    expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>30</integer>");
    expect(plist).toContain("<string>/Users/x/.casello-nodo/logs/launchd.out.log</string>");
    expect(plist).toContain("<string>/Users/x/.casello-nodo/logs/launchd.err.log</string>");
    expect(plist).toContain("<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>");
  });
  it("esegue l'escape XML dei valori", () => {
    const p = buildPlist({ programArguments: ["/a&b/<n>", "\"q\"", "run"], logsDir: "/l", path: "/p'x" });
    expect(p).toContain("<string>/a&amp;b/&lt;n&gt;</string>");
    expect(p).toContain("<string>&quot;q&quot;</string>");
    expect(p).toContain("<string>/p&apos;x</string>");
    expect(p).not.toContain("/a&b/");
  });
});

describe("servizio", () => {
  it("installService scrive il plist e fa bootstrap", async () => {
    const lc = fakeLaunchctl(false);
    await installService({ launchctl: lc.run, uid: 501, home, plist: "<plist/>" });
    expect(await readFile(plistPath(home), "utf8")).toBe("<plist/>");
    expect(lc.calls.map((c) => c[0])).toEqual(["print", "bootstrap"]);
    expect(lc.calls[1]).toEqual(["bootstrap", "gui/501", plistPath(home)]);
  });
  it("se è già caricato fa prima bootout", async () => {
    const lc = fakeLaunchctl(true);
    await installService({ launchctl: lc.run, uid: 501, home, plist: "<plist/>" });
    expect(lc.calls.map((c) => c[0])).toEqual(["print", "bootout", "print", "bootstrap"]);
    expect(lc.calls[1]).toEqual(["bootout", `gui/501/${LABEL}`]);
  });
  it("dopo il bootout aspetta che il servizio risulti scaricato prima del bootstrap", async () => {
    let prints = 0;
    const calls: string[] = [];
    const run: LaunchctlRunner = async (a) => {
      calls.push(a[0]);
      if (a[0] === "print") {
        prints += 1;
        // caricato alla prima verifica e per altre due dopo il bootout
        return prints <= 3 ? { code: 0, stdout: "", stderr: "" } : { code: 113, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await installService({ launchctl: run, uid: 501, home, plist: "x", pollMs: 1 });
    expect(calls).toEqual(["print", "bootout", "print", "print", "print", "bootstrap"]);
  });
  it("bootstrap fallito → errore", async () => {
    const run: LaunchctlRunner = async (a) =>
      a[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "boom" } : { code: 113, stdout: "", stderr: "" };
    await expect(installService({ launchctl: run, uid: 501, home, plist: "x" })).rejects.toThrow(/codice 5/);
  });
  it("uninstallService fa bootout e toglie il plist; non caricato non è un errore", async () => {
    await mkdir(path.dirname(plistPath(home)), { recursive: true });
    await writeFile(plistPath(home), "x");
    const lc = fakeLaunchctl(true);
    expect(await uninstallService({ launchctl: lc.run, uid: 501, home })).toEqual({ wasLoaded: true });
    expect(lc.calls.at(-1)).toEqual(["bootout", `gui/501/${LABEL}`]);
    await expect(stat(plistPath(home))).rejects.toThrow();
    const lc2 = fakeLaunchctl(false);
    expect(await uninstallService({ launchctl: lc2.run, uid: 501, home })).toEqual({ wasLoaded: false });
  });
  it("serviceStatus legge stato e pid", async () => {
    const lc = fakeLaunchctl(true, `x = {\n\tstate = running\n\tpid = 4242\n}`);
    expect(await serviceStatus(lc.run, 501)).toEqual({ loaded: true, running: true, pid: 4242 });
    expect(await serviceStatus(fakeLaunchctl(false).run, 501)).toEqual({ loaded: false, running: false, pid: null });
  });
});
