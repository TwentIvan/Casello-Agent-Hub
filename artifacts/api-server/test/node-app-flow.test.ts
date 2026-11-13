import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, nodesTable, pool } from "@workspace/db";
import { runAppMode, type AppDeps } from "../../casello-nodo/src/app-mode";
import { createPairingClient } from "../../casello-nodo/src/client";
import { NODE_VERSION } from "../../casello-nodo/src/capabilities";
import { defaultPaths, loadConfig, type Config } from "../../casello-nodo/src/config";
import type { Dialogs } from "../../casello-nodo/src/dialogs";
import type { LaunchctlRunner } from "../../casello-nodo/src/launchd";
import type { Logger } from "../../casello-nodo/src/log";
import { startLoop, type Loop, type LoopDeps } from "../../casello-nodo/src/loop";
import { uninstallSelf } from "../../casello-nodo/src/node-admin";
import { checkUpdateOnStart, updatePaths } from "../../casello-nodo/src/updater";
import { resetNodeManifestCache } from "../src/lib/nodes/manifest";
import { turnPollSettings } from "../src/lib/node-turns/protocol";

// Prova di flusso di Botcave Nodo senza terminale (spec §11): API vera in memoria (PGlite) e codice vero di
// casello-nodo, con dialoghi, `launchctl`, `open` e Claude Code finti e una cartella home temporanea. Lo stesso server
// HTTP fa da Botcave: `/api` va all'API, `/downloads/nodo/` serve i file come nginx in produzione.
// Abbinamento dal primo avvio dell'app → heartbeat `kind: "app"` con lo stato di Claude → aggiornamento proposto dal
// manifest, scaricato, verificato e sostituito (uscita 0 intercettata) → riavvio simulato → disinstallazione dalla console.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "NODO_MANIFEST_PATH"];
const saved: Record<string, string | undefined> = {};
const NEXT_VERSION = "0.5.0";
const NEW_BINARY = Buffer.from("#!/bin/sh\n# casello-nodo 0.4.0 finto\n".repeat(64));
const OLD_BINARY = "#!/bin/sh\n# casello-nodo 0.3.0 finto\n";
const CLAUDE = { found: true, version: "2.1.30", loggedIn: true, authMethod: "claude.ai", subscriptionType: "team" };

let base: string;
let server: http.Server;
let tmp: string;
let home: string;
let downloadsDir: string;
let prevTurnWait: number;
const downloads: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, p: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`attesa scaduta: ${what}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** `launchctl` finto: un solo servizio, caricato da `bootstrap` e scaricato da `bootout`. */
function fakeLaunchctl(calls: string[][]): LaunchctlRunner {
  let loaded = false;
  return async (args) => {
    calls.push(args);
    if (args[0] === "print") return loaded ? { code: 0, stdout: "state = running\npid = 4242\n", stderr: "" } : { code: 113, stdout: "", stderr: "" };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost", CASELLO_SECRET_KEY: "e".repeat(64) });
  vi.spyOn(console, "log").mockImplementation(() => {});
  tmp = await mkdtemp(path.join(tmpdir(), "botcave-nodo-flusso-"));
  home = path.join(tmp, "home");
  downloadsDir = path.join(tmp, "downloads");
  await mkdir(home, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  // Nessun manifest finché la prova non lo pubblica: nessun aggiornamento proposto
  process.env["NODO_MANIFEST_PATH"] = path.join(tmp, "manifest-assente.json");
  resetNodeManifestCache();
  // Attesa breve della presa dei turni: l'aggiornamento aspetta che il ciclo dei turni non abbia una presa in corso
  prevTurnWait = turnPollSettings.waitMs;
  turnPollSettings.waitMs = 500;
  const { default: app } = await import("../src/app");
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/downloads/nodo/")) {
      downloads.push(url);
      const name = path.basename(url);
      readFile(path.join(downloadsDir, name)).then(
        (data) => {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
          res.end(data);
        },
        () => {
          res.writeHead(404);
          res.end();
        },
      );
      return;
    }
    app(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env["PUBLIC_APP_URL"] = base;
  await pool.query("TRUNCATE users CASCADE");
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  await rm(tmp, { recursive: true, force: true });
  resetNodeManifestCache();
  turnPollSettings.waitMs = prevTurnWait;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("Botcave Nodo: dall'abbinamento alla disinstallazione senza terminale", () => {
  it("abbina, riferisce Claude, si aggiorna, riparte e si disinstalla dalla console", { timeout: 60_000 }, async () => {
    const launchctlCalls: string[][] = [];
    const launchctl = fakeLaunchctl(launchctlCalls);
    const alerts: string[] = [];
    const notifications: string[] = [];
    const opened: string[] = [];
    const workspace = path.join(home, "Lavori Botcave");
    await mkdir(workspace, { recursive: true });
    const dialogs: Dialogs = {
      alert: async (t) => void alerts.push(t),
      notify: async (_title, t) => void notifications.push(t),
      chooseFolder: async () => workspace,
      chooseFromList: async () => null,
      confirm: async () => true,
    };
    // L'eseguibile dell'app (Contents/MacOS/botcave-nodo) che l'installazione copia in ~/.casello-nodo/bin
    const programSource = path.join(tmp, "Botcave Nodo.app", "Contents", "MacOS", "botcave-nodo");
    await mkdir(path.dirname(programSource), { recursive: true });
    await writeFile(programSource, OLD_BINARY, { mode: 0o755 });

    // 1. Primo avvio dell'app: `open` apre la pagina /nodes/pair; l'utente (sessione di prova) la conferma
    let approvedCode: string | null = null;
    const deps: AppDeps = {
      home,
      uid: 501,
      launchctl,
      dialogs,
      openUrl: async (target) => {
        opened.push(target);
        const code = new URL(target).searchParams.get("code");
        if (!code) return;
        const info = await api("GET", `/account/node-pairings/${code}`);
        expect(info.status, info.text).toBe(200);
        expect(info.json.deviceName).toBe("MacBook di prova");
        const ok = await api("POST", `/account/node-pairings/${code}/approve`, { name: "MacBook di prova" });
        expect(ok.status, ok.text).toBe(200);
        approvedCode = code;
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      caselloUrl: base,
      pairingClient: (baseUrl) => createPairingClient({ baseUrl }),
      programSource,
      deviceName: async () => "MacBook di prova",
      version: NODE_VERSION,
      whichClaude: async () => null,
      claude: { found: async () => true, install: async () => {}, login: async () => {} },
    };
    expect(await runAppMode(deps)).toBe(0);
    expect(approvedCode).not.toBeNull();
    expect(opened[0]).toBe(`${base}/nodes/pair?code=${encodeURIComponent(approvedCode!)}`);
    expect(alerts).toEqual(["Botcave Nodo è collegato come «MacBook di prova»"]);

    const paths = defaultPaths(home);
    const upd = updatePaths(home);
    expect((await stat(paths.configPath)).mode & 0o777).toBe(0o600);
    const config: Config = loadConfig(paths.configPath, { home });
    expect(config.caselloUrl).toBe(base);
    expect(config.workspaceRoot).toBe(workspace);
    expect(config.token).toMatch(/^cas_/);
    expect(await readFile(upd.programPath, "utf8")).toBe(OLD_BINARY);
    expect(launchctlCalls.some((a) => a[0] === "bootstrap")).toBe(true);
    const plist = await readFile(path.join(home, "Library", "LaunchAgents", "cloud.fantamister.casello-nodo.plist"), "utf8");
    expect(plist).toContain(`<string>${upd.programPath}</string>`);
    expect(plist).toContain("<string>run</string>");

    const [node] = await db.select().from(nodesTable);
    expect(node).toMatchObject({ name: "MacBook di prova", status: "active" });
    expect(node!.pairedAt).not.toBeNull();
    // La richiesta è consumata: lo stesso codice non vale più
    expect((await api("GET", `/account/node-pairings/${approvedCode}`)).status).toBe(404);

    // 2. Il servizio parte con la config: heartbeat `kind: "app"` con lo stato di Claude Code
    const nodeLog: string[] = [];
    const logger: Logger = {
      info: (m) => nodeLog.push(`info ${m}`),
      warn: (m) => nodeLog.push(`warn ${m}`),
      error: (m) => nodeLog.push(`error ${m}`),
    };
    const exits: number[] = [];
    const loopDeps = (over: Partial<LoopDeps> = {}): LoopDeps => ({
      logger,
      statePath: paths.statePath,
      turnsDir: path.join(tmp, "turns"),
      turnErrorWaitMs: 200,
      drainPollMs: 50,
      // Un heartbeat per avvio (limite di 6/min per nodo): ogni fase riparte il ciclo
      heartbeatIntervalMs: 60 * 60_000,
      kind: "app",
      updatePaths: upd,
      claudeStatus: async () => CLAUDE,
      exit: (code) => void exits.push(code),
      notify: async (t) => void notifications.push(t),
      ...over,
    });
    let loop: Loop = startLoop(config, loopDeps());
    const beat = await until("primo heartbeat", async () => {
      const [n] = await db.select().from(nodesTable).where(eq(nodesTable.id, node!.id));
      return n?.claudeCheckedAt ? n : null;
    });
    expect(beat.kind).toBe("app");
    expect(beat.version).toBe(NODE_VERSION);
    expect(beat.workspaceRoot).toBe(workspace);
    expect(beat.claudeStatus).toMatchObject({ found: true, version: "2.1.30", loggedIn: true, subscriptionType: "team" });
    expect(downloads).toEqual([]);
    await loop.stop();

    // 3. Il deploy pubblica una versione più nuova: manifest e binario serviti da /downloads/nodo/
    await writeFile(path.join(downloadsDir, `casello-nodo-${NEXT_VERSION}`), NEW_BINARY);
    const sha256 = createHash("sha256").update(NEW_BINARY).digest("hex");
    const manifestPath = path.join(tmp, "nodo-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: NEXT_VERSION,
        minVersion: "0.2.0",
        binary: { file: `casello-nodo-${NEXT_VERSION}`, sha256, size: NEW_BINARY.length },
        app: { file: `Botcave-Nodo-${NEXT_VERSION}.zip`, sha256: "c".repeat(64), size: 10 },
      }),
    );
    process.env["NODO_MANIFEST_PATH"] = manifestPath;
    resetNodeManifestCache();
    loop = startLoop(config, loopDeps());
    await until("uscita dopo l'aggiornamento", () => exits.length > 0);
    expect(exits).toEqual([0]);
    expect(downloads).toEqual([`/downloads/nodo/casello-nodo-${NEXT_VERSION}`]);
    expect(await readFile(upd.programPath)).toEqual(NEW_BINARY);
    expect(await readFile(upd.prevPath, "utf8")).toBe(OLD_BINARY);
    expect(await exists(upd.downloadPath)).toBe(false);
    expect(JSON.parse(await readFile(upd.updateJsonPath, "utf8"))).toMatchObject({ from: NODE_VERSION, to: NEXT_VERSION, starts: 0 });
    await loop.stop();

    // 4. launchd riavvia il programma: nessun ritorno indietro, il primo heartbeat riuscito chiude l'aggiornamento.
    // La console intanto chiede la disinstallazione: la riceve quell'heartbeat
    expect(checkUpdateOnStart(upd)).toBe("ok");
    expect(JSON.parse(await readFile(upd.updateJsonPath, "utf8"))).toMatchObject({ starts: 1 });
    process.env["NODO_MANIFEST_PATH"] = path.join(tmp, "manifest-assente.json");
    resetNodeManifestCache();
    const req = await api("POST", `/account/nodes/${node!.id}/uninstall-request`);
    expect(req.status, req.text).toBe(200);
    let uninstallDone: Promise<void> | null = null;
    const restarted: Loop = startLoop(
      config,
      loopDeps({
        onUninstallRequested: () => {
          uninstallDone = uninstallSelf({
            home,
            uid: 501,
            launchctl,
            stopLoop: () => restarted.stop(),
            appMode: true,
            notify: async (t) => void notifications.push(t),
            exit: (code) => void exits.push(code),
          });
        },
      }),
    );
    loop = restarted;
    // `until` attende il valore restituito: una Promise si avvolge in un oggetto per non attenderne l'esito qui
    const pending = await until("disinstallazione chiesta", () => (uninstallDone ? { p: uninstallDone } : null));
    await pending.p;
    expect(exits).toEqual([0, 0]);
    expect(await exists(upd.updateJsonPath)).toBe(false);

    // 5. Il nodo è disattivato e il Mac pulito: programma (anche .prev), config con il token e LaunchAgent tolti;
    // log e cartella di lavoro restano
    const [after] = await db.select().from(nodesTable).where(eq(nodesTable.id, node!.id));
    expect(after!.status).toBe("disabled");
    expect(await exists(path.dirname(upd.programPath))).toBe(false);
    expect(await exists(paths.configPath)).toBe(false);
    expect(await exists(path.join(home, "Library", "LaunchAgents", "cloud.fantamister.casello-nodo.plist"))).toBe(false);
    expect(launchctlCalls.at(-1)?.[0]).toBe("bootout");
    expect(await exists(workspace)).toBe(true);
    expect(notifications).toContain("Botcave Nodo è stato rimosso. Puoi spostare l'app nel cestino.");
    // Il token del nodo è revocato: un heartbeat con la vecchia config non passa
    const hb = await fetch(`${base}/api/node/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ version: NODE_VERSION, executor: "claude-code", skills: [], workspaceRoot: workspace, maxConcurrent: 1 }),
    });
    expect([401, 403]).toContain(hb.status);

    // Né il token né il codice di abbinamento finiscono nel log del nodo
    const log = nodeLog.join("\n");
    expect(log).not.toContain(config.token);
    expect(log).not.toContain(approvedCode!);
    expect(log).toContain(`aggiornamento a ${NEXT_VERSION} installato: riavvio`);
  });
});
