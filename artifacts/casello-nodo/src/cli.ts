import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { ConfigError, defaultPaths, loadConfig, type Config } from "./config";
import {
  buildPlist,
  installService,
  plistPath,
  realLaunchctl,
  serviceStatus,
  uninstallService,
  type LaunchctlRunner,
} from "./launchd";
import { startLoop } from "./loop";
import { readState } from "./state";

export interface CliDeps {
  home: string;
  uid: number;
  launchctl: LaunchctlRunner;
  /** Eseguibile di node e script dell'entrata costruita (percorsi assoluti). */
  execPath: string;
  entryPath: string;
  /** Percorso di `claude` (`which claude`) o null se non trovato. */
  whichClaude: () => Promise<string | null>;
  /** Domanda interattiva; `hidden` = senza eco. Assente se l'input non è un terminale. */
  prompt?: (question: string, hidden: boolean) => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
  startLoop: typeof startLoop;
  /** Registra un gestore di segnale (SIGTERM, SIGINT). */
  onSignal: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
  exit: (code: number) => void;
  /** Ora corrente (iniettabile nei test). */
  now?: () => Date;
}

const USAGE = `uso: casello-nodo <comando>

  install     installa il servizio su launchd (--url, --token, --workspace-root)
  uninstall   rimuove il servizio (config e log restano)
  status      stato del servizio, ultimo heartbeat e compiti in corso
  run         avvia il nodo in primo piano
`;

const INSTALL_USAGE =
  "opzioni non valide.\nuso: casello-nodo install [--url <https://…>] [--token-file <file> | --token <token>] [--workspace-root <cartella>]";

class CliError extends Error {}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** Il token viaggia nell'header: https obbligatorio, http solo verso questa macchina. */
export function validateUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError("indirizzo di Casello non valido");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new CliError("l'indirizzo di Casello deve essere https");
  }
  return raw.replace(/\/+$/, "");
}

async function ensureDirectory(dir: string): Promise<void> {
  try {
    if ((await stat(dir)).isDirectory()) return;
  } catch {
    // assente: stesso errore
  }
  throw new CliError(`la radice degli spazi di lavoro non esiste: ${dir}`);
}

/** Directory del servizio: quella di `claude` e quelle di sempre, perché launchd non ha il PATH della shell. */
export function servicePath(claudeBin: string | null, execPath: string, home: string): string {
  const fallback = ["/usr/local/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin")];
  const dirs = [
    ...(claudeBin ? [path.dirname(claudeBin)] : fallback),
    path.dirname(execPath),
    ...fallback,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

async function install(argv: string[], d: CliDeps): Promise<number> {
  let values: { url?: string; token?: string; "token-file"?: string; "workspace-root"?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        "token-file": { type: "string" },
        "workspace-root": { type: "string" },
      },
      strict: true,
    }));
  } catch {
    throw new CliError(INSTALL_USAGE);
  }
  if (values.token && values["token-file"]) throw new CliError("usa --token oppure --token-file, non entrambi");
  let tokenValue = values.token;
  if (values["token-file"]) {
    try {
      tokenValue = (await readFile(expandHome(values["token-file"], d.home), "utf8")).trim();
    } catch {
      throw new CliError("file del token non leggibile");
    }
  }
  const ask = async (value: string | undefined, question: string, hidden = false): Promise<string> => {
    if (value) return value;
    if (!d.prompt) throw new CliError(`manca ${question.toLowerCase()}: passalo come opzione`);
    return (await d.prompt(`${question}: `, hidden)).trim();
  };
  const url = validateUrl(await ask(values.url, "Indirizzo di Casello (https)"));
  const token = await ask(tokenValue, "Token del nodo", true);
  if (!token) throw new CliError("il token è vuoto");
  const workspaceRoot = path.resolve(expandHome(await ask(values["workspace-root"], "Radice degli spazi di lavoro"), d.home));
  await ensureDirectory(workspaceRoot);
  if (!/\.(mjs|js)$/.test(d.entryPath)) {
    throw new CliError("eseguibile non costruito: esegui `pnpm --filter @workspace/casello-nodo run build`");
  }

  const paths = defaultPaths(d.home);
  const configDir = path.dirname(paths.configPath);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // La cartella può esistere già con permessi più larghi
  await chmod(configDir, 0o700);
  // Il token non passa mai da un file con permessi larghi: file temporaneo creato 600, poi rename sulla config
  const tmp = `${paths.configPath}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, `${JSON.stringify({ caselloUrl: url, token, workspaceRoot }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(tmp, paths.configPath);
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });

  const claudeBin = await d.whichClaude();
  if (!claudeBin) {
    d.err("attenzione: `claude` non trovato nel PATH; uso /usr/local/bin, /opt/homebrew/bin e ~/.local/bin. Installa Claude Code e fai il login.\n");
  }
  const plist = buildPlist({
    programArguments: [d.execPath, d.entryPath, "run"],
    logsDir: paths.logsDir,
    path: servicePath(claudeBin, d.execPath, d.home),
  });
  await installService({ launchctl: d.launchctl, uid: d.uid, home: d.home, plist });
  d.out(`Servizio installato e avviato (${plistPath(d.home)}).\nConfig: ${paths.configPath}\nLog: ${paths.logsDir}\n`);
  return 0;
}

async function uninstall(d: CliDeps): Promise<number> {
  const { wasLoaded } = await uninstallService({ launchctl: d.launchctl, uid: d.uid, home: d.home });
  const paths = defaultPaths(d.home);
  d.out(
    `${wasLoaded ? "Servizio fermato e rimosso" : "Servizio non caricato; plist rimosso"}.\nConfig e log restano: ${paths.configPath} e ${paths.logsDir}\n`,
  );
  return 0;
}

async function status(d: CliDeps): Promise<number> {
  const s = await serviceStatus(d.launchctl, d.uid);
  d.out(
    s.loaded
      ? `launchd: servizio caricato${s.running ? `, in esecuzione${s.pid ? ` (pid ${s.pid})` : ""}` : ", non in esecuzione"}\n`
      : "launchd: servizio non caricato (usa `casello-nodo install`)\n",
  );
  const state = await readState(defaultPaths(d.home).statePath);
  if (!state) {
    d.out("Stato: nessun dato (il nodo non è ancora partito)\n");
    return 0;
  }
  const beat = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : NaN;
  const ageMin = Number.isNaN(beat) ? null : Math.floor(((d.now?.() ?? new Date()).getTime() - beat) / 60_000);
  d.out(
    `Ultimo heartbeat riuscito: ${state.lastHeartbeatAt ?? "mai"}${ageMin !== null && ageMin >= 2 ? ` (nessun contatto da ${ageMin} minuti)` : ""}\n`,
  );
  d.out(
    state.tasks.length === 0
      ? "Compiti in corso: nessuno\n"
      : `Compiti in corso: ${state.tasks.map((t) => `#${t.taskId} (dal ${t.startedAt})`).join(", ")}\n`,
  );
  if (state.lastError) d.out(`Ultimo errore: ${state.lastError}\n`);
  d.out(`Stato aggiornato il ${state.updatedAt}\n`);
  return 0;
}

async function run(d: CliDeps): Promise<number> {
  const paths = defaultPaths(d.home);
  let config: Config;
  try {
    config = loadConfig(paths.configPath, { home: d.home });
  } catch (e) {
    throw new CliError(e instanceof ConfigError ? e.message : "config non leggibile");
  }
  const loop = d.startLoop(config, { logsDir: paths.logsDir, statePath: paths.statePath });
  return new Promise<number>((resolve) => {
    let signals = 0;
    const handler = () => {
      signals += 1;
      if (signals > 1) {
        d.exit(1);
        return;
      }
      void loop.stop().then(() => resolve(0));
    };
    d.onSignal("SIGTERM", handler);
    d.onSignal("SIGINT", handler);
  });
}

/** Esegue un comando e restituisce il codice di uscita; gli errori attesi si stampano senza traccia dello stack. */
export async function runCli(argv: string[], d: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "install":
        return await install(rest, d);
      case "uninstall":
        return await uninstall(d);
      case "status":
        return await status(d);
      case "run":
        return await run(d);
      default:
        d.err(USAGE);
        return command === undefined || command === "--help" || command === "help" ? 0 : 1;
    }
  } catch (e) {
    d.err(`${e instanceof CliError || e instanceof Error ? e.message : "errore"}\n`);
    return 1;
  }
}

function whichClaudeReal(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", ["claude"], (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

function realPrompt(question: string, hidden: boolean): Promise<string> {
  if (!hidden) {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
  // Lettura carattere per carattere dal terminale in modalità raw: nessuna eco del token
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let text = "";
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(text);
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new CliError("annullato"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Dipendenze reali del processo. */
export function realDeps(entryPath: string): CliDeps {
  return {
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    launchctl: realLaunchctl,
    execPath: process.execPath,
    entryPath,
    whichClaude: whichClaudeReal,
    ...(process.stdin.isTTY ? { prompt: realPrompt } : {}),
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    startLoop,
    onSignal: (sig, h) => void process.on(sig, h),
    exit: (code) => process.exit(code),
  };
}
