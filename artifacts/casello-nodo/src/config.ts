import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/** Configurazione del nodo (`~/.casello-nodo/config.json`, permessi 600). */
export interface Config {
  caselloUrl: string;
  token: string;
  workspaceRoot: string;
  claudeBin: string;
  permissionMode: string;
  skillsDirs: string[];
  maxConcurrent: number;
  taskTimeoutMinutes: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface NodePaths {
  configPath: string;
  logsDir: string;
  statePath: string;
  /** Copia del programma usata dal servizio: non dipende dalla cartella in cui è stato costruito. */
  programPath: string;
}

/** Percorsi predefiniti del nodo sotto `~/.casello-nodo`. */
export function defaultPaths(home = homedir()): NodePaths {
  const dir = path.join(home, ".casello-nodo");
  return {
    configPath: path.join(dir, "config.json"),
    logsDir: path.join(dir, "logs"),
    statePath: path.join(dir, "state.json"),
    programPath: path.join(dir, "bin", "casello-nodo.mjs"),
  };
}

/** Cartelle delle skill di Claude Code: quelle dell'utente e la cache dei plugin. */
export function defaultSkillsDirs(home = homedir()): string[] {
  return [path.join(home, ".claude", "skills"), path.join(home, ".claude", "plugins", "cache")];
}

const ConfigFile = z.object({
  caselloUrl: z.string().url(),
  token: z.string().min(1),
  workspaceRoot: z.string().min(1),
  claudeBin: z.string().min(1).default("claude"),
  permissionMode: z.string().min(1).default("bypassPermissions"),
  skillsDirs: z.array(z.string().min(1)).optional(),
  maxConcurrent: z.number().int().min(1).max(3).default(1),
  taskTimeoutMinutes: z
    .number()
    .positive()
    .max(24 * 60)
    .default(60),
});

/** Il token viaggia nell'header: https obbligatorio, http solo verso questa macchina (sviluppo e test). */
function isSecureUrl(url: string): boolean {
  const u = new URL(url);
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Legge e valida la configurazione. Rifiuta un file leggibile o scrivibile da altri (permessi diversi da 600):
 * contiene il token del nodo.
 */
export function loadConfig(configPath = defaultPaths().configPath, opts: { home?: string } = {}): Config {
  const home = opts.home ?? homedir();
  let mode: number;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    throw new ConfigError(`config non trovata: ${configPath}`);
  }
  if (mode !== 0o600) throw new ConfigError("config leggibile da altri: chmod 600");

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new ConfigError("config non valida: JSON non leggibile");
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) {
    // Solo i nomi dei campi, mai i valori (il token non deve finire nei messaggi)
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(radice)"))];
    throw new ConfigError(`config non valida: controlla ${fields.join(", ")}`);
  }
  const c = parsed.data;
  if (!isSecureUrl(c.caselloUrl)) throw new ConfigError("caselloUrl deve essere https");
  return {
    caselloUrl: c.caselloUrl.replace(/\/+$/, ""),
    token: c.token,
    workspaceRoot: expandHome(c.workspaceRoot, home),
    claudeBin: expandHome(c.claudeBin, home),
    permissionMode: c.permissionMode,
    skillsDirs: (c.skillsDirs ?? defaultSkillsDirs(home)).map((d) => expandHome(d, home)),
    maxConcurrent: c.maxConcurrent,
    taskTimeoutMinutes: c.taskTimeoutMinutes,
  };
}
