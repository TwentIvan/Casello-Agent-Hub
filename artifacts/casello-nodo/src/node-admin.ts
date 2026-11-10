import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { uninstallLocal } from "./cli";
import type { Config, NodePaths } from "./config";
import type { LaunchctlRunner } from "./launchd";
import { LOG_FILE } from "./log";

/** Corpo JSON di `POST /api/node/diagnostics` al più 256 KB (limite del parser del protocollo dei nodi). */
export const DIAGNOSTICS_MAX_BODY_BYTES = 256 * 1024 - 1024;
export const DIAGNOSTICS_LOG_LINES = 500;

export const UNINSTALLED_TEXT = "Botcave Nodo è stato rimosso. Puoi spostare l'app nel cestino.";

export interface DiagnosticsDeps {
  paths: NodePaths;
  config: Config;
  version: string;
  /** `sw_vers -productVersion`; null se non disponibile. */
  osVersion(): Promise<string | null>;
  /** Esito dell'ultima verifica di Claude Code (Task 6); undefined se non disponibile. */
  claudeStatus(): Promise<unknown>;
  send(content: string): Promise<void>;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function bodyBytes(content: string): number {
  return Buffer.byteLength(JSON.stringify({ content }));
}

/**
 * Testo della diagnosi (spec §7): versioni, esito di Claude, config senza `token`, `state.json` e le ultime 500 righe
 * di `casello-nodo.log` (già senza segreti). Il token si toglie comunque ovunque compaia; il log si accorcia dalle
 * righe più vecchie finché il corpo della richiesta non sta in 256 KB.
 */
export async function buildDiagnostics(d: DiagnosticsDeps): Promise<string> {
  const { token: _token, ...configWithoutToken } = d.config;
  const claude = await d.claudeStatus().catch(() => undefined);
  const header = [
    "Diagnosi di Botcave Nodo",
    `Generata il: ${new Date().toISOString()}`,
    `Versione del nodo: ${d.version}`,
    `macOS: ${(await d.osVersion().catch(() => null)) ?? "non disponibile"}`,
    `Claude Code: ${claude === undefined ? "non verificato" : JSON.stringify(claude)}`,
    "",
    "== Config (senza token) ==",
    JSON.stringify(configWithoutToken, null, 2),
    "",
    "== state.json ==",
    (await readText(d.paths.statePath))?.trim() ?? "assente",
    "",
    `== Ultime ${DIAGNOSTICS_LOG_LINES} righe di ${LOG_FILE} ==`,
  ].join("\n");
  const log = (await readText(path.join(d.paths.logsDir, LOG_FILE))) ?? "";
  let lines = log.split("\n").filter((l) => l.length > 0).slice(-DIAGNOSTICS_LOG_LINES);

  const redact = (text: string) => (d.config.token ? text.split(d.config.token).join("***") : text);
  const compose = () => redact(`${header}\n${lines.join("\n")}\n`);
  let content = compose();
  // Si tolgono le righe più vecchie a blocchi (poche iterazioni anche con righe lunghe)
  while (bodyBytes(content) > DIAGNOSTICS_MAX_BODY_BYTES && lines.length > 0) {
    lines = lines.slice(Math.max(1, Math.ceil(lines.length / 10)));
    content = compose();
  }
  // Intestazione da sola troppo grande (stato enorme): taglio netto
  while (bodyBytes(content) > DIAGNOSTICS_MAX_BODY_BYTES) content = content.slice(0, Math.floor(content.length * 0.9));
  return content;
}

export async function sendDiagnostics(d: DiagnosticsDeps): Promise<void> {
  await d.send(await buildDiagnostics(d));
}

/** Versione di macOS (`sw_vers -productVersion`, 10 s). */
export function realOsVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/sw_vers", ["-productVersion"], { timeout: 10_000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim().slice(0, 50) || null),
    );
  });
}

export interface UninstallSelfDeps {
  home: string;
  uid: number;
  launchctl: LaunchctlRunner;
  fetch?: typeof fetch;
  /** Ferma il ciclo: il lavoro in corso si chiude come uno stop. */
  stopLoop(): Promise<void>;
  /** Installato con l'app: notifica finale. */
  appMode: boolean;
  notify?: (text: string) => Promise<void>;
  exit(code: number): void;
}

/**
 * Disinstallazione chiesta dalla console (spec §8): ferma il lavoro come uno stop, poi la disinstallazione locale
 * (avviso a Botcave, programma, `.prev`, config e plist tolti, log e spazi di lavoro restano). La notifica si mostra
 * prima del `bootout`, che termina questo stesso processo.
 */
export async function uninstallSelf(d: UninstallSelfDeps): Promise<void> {
  await d.stopLoop().catch(() => {});
  await uninstallLocal(d, {
    removeConfig: true,
    beforeBootout:
      d.appMode && d.notify ? () => d.notify!(UNINSTALLED_TEXT).catch(() => {}) : undefined,
  });
  d.exit(0);
}
