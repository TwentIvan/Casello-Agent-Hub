// Link dal vivo: quick tunnel di Cloudflare sulla porta dell'App. `cloudflared` si scarica da una release fissa
// e si verifica con lo sha256 scritto qui; l'indirizzo `https://….trycloudflare.com` si legge dall'uscita del processo.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Release 2026.11.0, asset `cloudflared-linux-amd64` (sha256 dal digest dell'asset su GitHub e dalle note della release). */
export const CLOUDFLARED_VERSION = "2026.11.0";
export const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`;
export const CLOUDFLARED_SHA256 = "51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd";
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const URL_TIMEOUT_MS = 60_000;
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type Tunnel = { url: string; close(): void };

export const TUNNEL_MESSAGES = {
  download: "cloudflared non scaricato",
  checksum: "cloudflared non verificato: sha256 diverso",
  noUrl: "il tunnel non ha dato un indirizzo",
} as const;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Scarica e verifica cloudflared (riusa una copia già verificata nella cartella). */
export async function ensureCloudflared(dir: string = path.join(tmpdir(), "casello-collaudo-bin")): Promise<string> {
  const bin = path.join(dir, `cloudflared-${CLOUDFLARED_VERSION}`);
  try {
    if (sha256(await readFile(bin)) === CLOUDFLARED_SHA256) return bin;
  } catch {
    // non ancora scaricato
  }
  let bytes: Buffer;
  try {
    const res = await fetch(CLOUDFLARED_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(TUNNEL_MESSAGES.download);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BINARY_BYTES) throw new Error(TUNNEL_MESSAGES.download);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new Error(TUNNEL_MESSAGES.download);
  }
  if (bytes.length > MAX_BINARY_BYTES || sha256(bytes) !== CLOUDFLARED_SHA256) throw new Error(TUNNEL_MESSAGES.checksum);
  await mkdir(dir, { recursive: true });
  const tmp = `${bin}.download`;
  await writeFile(tmp, bytes, { mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, bin);
  return bin;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // già terminato
  }
}

/** Avvia il tunnel con un eseguibile già verificato e aspetta l'indirizzo. */
export function startTunnel(bin: string, port: number, timeoutMs: number = URL_TIMEOUT_MS): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let seen = "";
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child);
      reject(new Error(TUNNEL_MESSAGES.noUrl));
    };
    const timer = setTimeout(fail, timeoutMs);
    const onData = (chunk: Buffer) => {
      if (settled) return;
      seen = (seen + chunk.toString("utf8")).slice(-8_000);
      const match = TUNNEL_URL.exec(seen);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: match[0], close: () => killGroup(child) });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", fail);
    child.on("exit", fail);
  });
}

export async function openTunnel(port: number): Promise<Tunnel> {
  return startTunnel(await ensureCloudflared(), port);
}
