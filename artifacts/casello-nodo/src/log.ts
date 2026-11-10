import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  /** Cartella dei log (es. `~/.casello-nodo/logs`). */
  dir: string;
  /** Scrive anche su stdout (default sì). */
  stdout?: boolean;
  /** Valori da oscurare comunque (token del nodo, lease). */
  secrets?: string[];
  maxBytes?: number;
  maxFiles?: number;
}

export const LOG_FILE = "casello-nodo.log";
const TOKEN_PATTERN = /ca[st]_[A-Za-z0-9_-]+/g;

/**
 * Log su file con rotazione (10 MB, 5 file) e su stdout. Chi chiama non passa mai token, contenuti degli allegati,
 * istruzioni del pacchetto o output della CLI; per difesa i token `cas_…` e i segreti dichiarati sono oscurati.
 */
export function createLogger(opts: LoggerOptions): Logger & { addSecret(secret: string): void } {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 5;
  const secrets = new Set((opts.secrets ?? []).filter(Boolean));
  const file = path.join(opts.dir, LOG_FILE);
  let dirReady = false;

  function redact(text: string): string {
    let out = text.replace(TOKEN_PATTERN, "***");
    for (const s of secrets) out = out.split(s).join("***");
    return out.replace(/[\r\n]+/g, " ");
  }

  function rotate(): void {
    rmSync(`${file}.${maxFiles - 1}`, { force: true });
    for (let i = maxFiles - 2; i >= 1; i--) {
      try {
        renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        // file assente: niente da spostare
      }
    }
    renameSync(file, `${file}.1`);
  }

  function write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${redact(message)}\n`;
    if (opts.stdout !== false) process.stdout.write(line);
    try {
      if (!dirReady) {
        mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
        dirReady = true;
      }
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // il log su file non deve mai fermare il nodo
    }
  }

  return {
    info: (m) => write("INFO", m),
    warn: (m) => write("WARN", m),
    error: (m) => write("ERROR", m),
    addSecret: (s) => {
      if (s) secrets.add(s);
    },
  };
}
