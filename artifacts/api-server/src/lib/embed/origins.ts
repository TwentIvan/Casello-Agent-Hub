import { logger } from "../logger";
import { oauthBase } from "../oauth/config";

const warned = new Set<string>();

function warnOnce(value: string): void {
  if (warned.has(value)) return;
  warned.add(value);
  logger.warn({ value }, "Origine di EMBED_ALLOWED_ORIGINS scartata");
}

/** Origine normalizzata se ammessa: `https://host[:porta]` senza path; localhost e 127.0.0.1 con porta solo fuori produzione. */
export function normalizeEmbedOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && process.env["NODE_ENV"] !== "production") {
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port !== "") return url.origin;
  }
  return null;
}

/** Origini delle app ospiti ammesse a incorporare Botcave (`EMBED_ALLOWED_ORIGINS`, separate da virgola; letta a ogni chiamata). */
export function embedAllowedOrigins(): string[] {
  const raw = process.env["EMBED_ALLOWED_ORIGINS"] ?? "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "") continue;
    const origin = normalizeEmbedOrigin(value);
    if (origin === null) {
      warnOnce(value);
      continue;
    }
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

export function embedClientId(origin: string): string {
  return `embed:${origin}`;
}

export function originOfEmbedClient(clientId: string): string | null {
  return clientId.startsWith("embed:") ? clientId.slice("embed:".length) : null;
}

export function embedCallbackUri(): string {
  return `${oauthBase().issuer}/embed/callback`;
}
