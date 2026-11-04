import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const LABEL = "cloud.fantamister.casello-nodo";

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Esegue `launchctl` con gli argomenti dati; iniettabile per i test (mai il vero `launchctl`). */
export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

export const realLaunchctl: LaunchctlRunner = (args) =>
  new Promise((resolve) => {
    execFile("/bin/launchctl", args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface PlistOptions {
  /** Comando e argomenti: node + percorso assoluto dell'eseguibile + `run`. */
  programArguments: string[];
  logsDir: string;
  /** PATH dell'ambiente del servizio (launchd non ha il PATH della shell). */
  path: string;
  label?: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Plist del LaunchAgent: avvio al login e riavvio se cade. Non contiene mai il token. */
export function buildPlist(opts: PlistOptions): string {
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(opts.label ?? LABEL)}
  <key>ProgramArguments</key>
  <array>
${opts.programArguments.map((a) => `    ${s(a)}`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${s(opts.path)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${s(path.join(opts.logsDir, "launchd.out.log"))}
  <key>StandardErrorPath</key>
  ${s(path.join(opts.logsDir, "launchd.err.log"))}
</dict>
</plist>
`;
}

export function plistPath(home = homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function serviceTarget(uid: number): string {
  return `gui/${uid}/${LABEL}`;
}

export interface ServiceStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

/** Stato del servizio in launchd (`launchctl print`). */
export async function serviceStatus(launchctl: LaunchctlRunner, uid: number): Promise<ServiceStatus> {
  const r = await launchctl(["print", serviceTarget(uid)]);
  if (r.code !== 0) return { loaded: false, running: false, pid: null };
  const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
  return { loaded: true, running: state === "running" || pid !== undefined, pid: pid ? Number(pid) : null };
}

/** Scrive il plist e (ri)carica il servizio: se è già caricato si scarica prima. */
export async function installService(opts: {
  launchctl: LaunchctlRunner;
  uid: number;
  home: string;
  plist: string;
}): Promise<void> {
  const file = plistPath(opts.home);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, opts.plist, { mode: 0o644 });
  if ((await serviceStatus(opts.launchctl, opts.uid)).loaded) {
    await opts.launchctl(["bootout", serviceTarget(opts.uid)]);
  }
  const r = await opts.launchctl(["bootstrap", `gui/${opts.uid}`, file]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap non riuscito (codice ${r.code}): ${r.stderr.trim()}`);
}

/** Scarica il servizio (se non è caricato non è un errore) e toglie il plist. */
export async function uninstallService(opts: {
  launchctl: LaunchctlRunner;
  uid: number;
  home: string;
}): Promise<{ wasLoaded: boolean }> {
  const wasLoaded = (await serviceStatus(opts.launchctl, opts.uid)).loaded;
  if (wasLoaded) await opts.launchctl(["bootout", serviceTarget(opts.uid)]);
  await rm(plistPath(opts.home), { force: true });
  return { wasLoaded };
}
