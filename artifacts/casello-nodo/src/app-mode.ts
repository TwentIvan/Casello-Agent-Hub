import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { installFromConfig, uninstallLocal } from "./cli";
import { createPairingClient, type PairingClient } from "./client";
import { ConfigError, defaultPaths, loadConfig, writeConfigMerged, type Config } from "./config";
import { osascriptDialogs, type Dialogs } from "./dialogs";
import { UNINSTALLED_TEXT } from "./node-admin";
import { realLaunchctl, serviceTarget, type LaunchctlRunner } from "./launchd";
import { PairingFailedError, runPairing } from "./pairing";

/** Azioni su Claude Code (verifica, installazione, login): le implementa il Task 6. */
export interface ClaudeActions {
  found(): Promise<boolean>;
  install(): Promise<void>;
  login(): Promise<void>;
}

export interface AppDeps {
  home: string;
  uid: number;
  launchctl: LaunchctlRunner;
  dialogs: Dialogs;
  /** Apre un indirizzo o un percorso con `open`. */
  openUrl: (target: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Indirizzo di Botcave per un abbinamento nuovo (`appBaseUrl`). */
  caselloUrl: string;
  pairingClient: (baseUrl: string) => PairingClient;
  /** Eseguibile dell'app da copiare in `~/.casello-nodo/bin/casello-nodo`. */
  programSource: string;
  deviceName: () => Promise<string>;
  version: string;
  whichClaude: () => Promise<string | null>;
  claude: ClaudeActions;
  /** `fetch` per l'avviso di disinstallazione a Botcave (iniettabile nei test). */
  fetch?: typeof fetch;
}

/** Voci del menu nell'ordine della spec §4. */
export const MENU_ITEMS = [
  "Apri Botcave",
  "Installa Claude Code",
  "Accedi a Claude",
  "Cambia cartella di lavoro",
  "Apri i log",
  "Ricollega",
  "Disinstalla",
] as const;
type MenuItem = (typeof MENU_ITEMS)[number];

const UNREACHABLE_TEXT = "Botcave non raggiungibile: controlla la connessione e riapri Botcave Nodo";
const FAILED_TEXT = "Operazione non riuscita: riprova; se si ripete, apri i log dal menu di Botcave Nodo";
const connectedText = (name: string) => `Botcave Nodo è collegato come «${name}»`;

/** Avviato con un doppio clic: l'eseguibile sta dentro un pacchetto `.app`. */
export function isAppExecPath(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\//.test(execPath);
}

function readConfig(home: string): Config | null {
  try {
    return loadConfig(defaultPaths(home).configPath, { home });
  } catch (e) {
    if (e instanceof ConfigError) return null;
    throw e;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Riavvia il servizio perché rilegga la config. */
async function restartService(d: AppDeps): Promise<void> {
  await d.launchctl(["kickstart", "-k", serviceTarget(d.uid)]);
}

/** Abbinamento; null se non riuscito (dialogo già mostrato). */
async function pair(d: AppDeps, caselloUrl: string): Promise<{ token: string; nodeName: string } | null> {
  try {
    return await runPairing({
      caselloUrl,
      client: d.pairingClient(caselloUrl),
      dialogs: d.dialogs,
      openUrl: d.openUrl,
      sleep: d.sleep,
      now: d.now,
      deviceName: (await d.deviceName()).slice(0, 100) || "Mac",
      version: d.version,
    });
  } catch (e) {
    if (!(e instanceof PairingFailedError)) await d.dialogs.alert(UNREACHABLE_TEXT).catch(() => {});
    return null;
  }
}

/** Primo collegamento: abbinamento, cartella di lavoro (annullato: `~/Botcave`), installazione. */
async function firstRun(d: AppDeps): Promise<number> {
  const paired = await pair(d, d.caselloUrl);
  if (!paired) return 1;
  const fallback = path.join(d.home, "Botcave");
  await mkdir(fallback, { recursive: true });
  const chosen = await d.dialogs.chooseFolder(
    "Scegli la cartella in cui Botcave Nodo può lavorare (gli spazi di lavoro delle squadre stanno qui dentro)",
    fallback,
  );
  const workspaceRoot = chosen ?? fallback;
  await installFromConfig({ caselloUrl: d.caselloUrl, token: paired.token, workspaceRoot }, d.programSource, d);
  await d.dialogs.alert(connectedText(paired.nodeName));
  return 0;
}

/** Config della CLI trovata: la adotta senza toccarla, sostituisce programma e LaunchAgent. */
async function adoptCliConfig(d: AppDeps, cfg: Config): Promise<number> {
  await installFromConfig(cfg, d.programSource, d, { writeConfig: false });
  await d.dialogs.alert("Botcave Nodo usa il collegamento già presente su questo Mac ed è attivo.");
  return 0;
}

async function menu(d: AppDeps, cfg: Config): Promise<number> {
  const claudeFound = await d.claude.found();
  const items = MENU_ITEMS.filter((i) => i !== "Installa Claude Code" || !claudeFound);
  const choice = (await d.dialogs.chooseFromList("Botcave Nodo", items)) as MenuItem | null;
  const paths = defaultPaths(d.home);
  switch (choice) {
    case null:
      return 0;
    case "Apri Botcave":
      await d.openUrl(`${cfg.caselloUrl}/account`);
      return 0;
    case "Installa Claude Code":
      await d.claude.install();
      return 0;
    case "Accedi a Claude":
      await d.claude.login();
      return 0;
    case "Cambia cartella di lavoro": {
      const folder = await d.dialogs.chooseFolder("Scegli la cartella in cui Botcave Nodo può lavorare", cfg.workspaceRoot);
      if (!folder) return 0;
      await writeConfigMerged(paths.configPath, { workspaceRoot: folder });
      await restartService(d);
      await d.dialogs.notify("Botcave Nodo", `Cartella di lavoro: ${folder}`).catch(() => {});
      return 0;
    }
    case "Apri i log":
      await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
      await d.openUrl(paths.logsDir);
      return 0;
    case "Ricollega": {
      const paired = await pair(d, cfg.caselloUrl);
      if (!paired) return 1;
      await writeConfigMerged(paths.configPath, { token: paired.token });
      await restartService(d);
      await d.dialogs.alert(connectedText(paired.nodeName));
      return 0;
    }
    case "Disinstalla": {
      const ok = await d.dialogs.confirm(
        "Vuoi rimuovere Botcave Nodo da questo Mac? Il servizio si ferma e il collegamento si cancella; log e cartelle di lavoro restano.",
        "Disinstalla",
      );
      if (!ok) return 0;
      await uninstallLocal(d, {
        removeConfig: true,
        beforeBootout: () => d.dialogs.notify("Botcave Nodo", UNINSTALLED_TEXT).catch(() => {}),
      });
      return 0;
    }
    default:
      return 0;
  }
}

/**
 * Modalità app (doppio clic, spec §4): non collegato → abbinamento; config della CLI senza l'eseguibile dell'app →
 * adozione; collegato → menu. Restituisce il codice d'uscita.
 */
export async function runAppMode(d: AppDeps): Promise<number> {
  try {
    const cfg = readConfig(d.home);
    if (!cfg) return await firstRun(d);
    if (!(await exists(defaultPaths(d.home).appProgramPath))) return await adoptCliConfig(d, cfg);
    return await menu(d, cfg);
  } catch {
    // Nessun dettaglio nel dialogo: può contenere percorsi o testi interni
    await d.dialogs.alert(FAILED_TEXT).catch(() => {});
    return 1;
  }
}

/** Claude Code: in attesa del Task 6 le voci mostrano solo un avviso. */
export function placeholderClaudeActions(dialogs: Dialogs, whichClaude: () => Promise<string | null>): ClaudeActions {
  return {
    found: async () => (await whichClaude()) !== null,
    install: () => dialogs.alert("Disponibile a breve"),
    login: () => dialogs.alert("Disponibile a breve"),
  };
}

function execText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

/** Nome del Mac (`scutil --get ComputerName`), altrimenti il nome host; al più 100 caratteri. */
async function realDeviceName(): Promise<string> {
  const name = (await execText("/usr/sbin/scutil", ["--get", "ComputerName"])) ?? hostname();
  return name.slice(0, 100);
}

function realOpen(target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [target], { timeout: 10_000 }, (err) => (err ? reject(new Error("apertura non riuscita")) : resolve()));
  });
}

/** Dipendenze reali della modalità app. */
export function realAppDeps(opts: { caselloUrl: string; version: string; programSource: string }): AppDeps {
  const dialogs = osascriptDialogs();
  const whichClaude = () => execText("/usr/bin/which", ["claude"]);
  return {
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    launchctl: realLaunchctl,
    dialogs,
    openUrl: realOpen,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    caselloUrl: opts.caselloUrl,
    pairingClient: (baseUrl) => createPairingClient({ baseUrl }),
    programSource: opts.programSource,
    deviceName: realDeviceName,
    version: opts.version,
    whichClaude,
    claude: placeholderClaudeActions(dialogs, whichClaude),
  };
}
