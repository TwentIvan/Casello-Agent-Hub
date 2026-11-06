import { timingSafeEqual } from "node:crypto";
import { db, oauthClientsTable, type OAuthClient } from "@workspace/db";
import { sha256Hex } from "./authorize";

// Client OAuth di prima parte (es. The Hub Up), dichiarati nella variabile OAUTH_PLUGIN_CLIENTS.
export type PluginClient = { clientId: string; name: string; redirectUri: string; secretSha256: string };

export const PLUGIN_SCOPES = ["api:read", "api:write"] as const;

const MAX_PLUGIN_CLIENTS = 10;
const CLIENT_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Errore di configurazione: il messaggio nomina la variabile e il motivo, mai il suo valore. */
export class PluginConfigError extends Error {
  constructor(reason: string) {
    super(`OAUTH_PLUGIN_CLIENTS non valida: ${reason}`);
    this.name = "PluginConfigError";
  }
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || value.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && process.env["NODE_ENV"] !== "production") {
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port !== "";
  }
  return false;
}

/** Legge la configurazione a ogni chiamata (nessuna cache: i test la cambiano). Assente o vuota → []. */
export function pluginClients(): PluginClient[] {
  const raw = process.env["OAUTH_PLUGIN_CLIENTS"];
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginConfigError("JSON non valido");
  }
  if (!Array.isArray(parsed)) throw new PluginConfigError("deve essere un array JSON");
  if (parsed.length > MAX_PLUGIN_CLIENTS) throw new PluginConfigError(`al massimo ${MAX_PLUGIN_CLIENTS} voci`);
  const seen = new Set<string>();
  return parsed.map((entry, i): PluginClient => {
    const at = `voce ${i + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new PluginConfigError(`${at}: deve essere un oggetto`);
    const e = entry as Record<string, unknown>;
    if (typeof e["clientId"] !== "string" || !CLIENT_ID_RE.test(e["clientId"])) throw new PluginConfigError(`${at}: clientId non valido`);
    if (seen.has(e["clientId"])) throw new PluginConfigError(`${at}: clientId ripetuto`);
    seen.add(e["clientId"]);
    if (typeof e["name"] !== "string" || e["name"].length < 1 || e["name"].length > 100) throw new PluginConfigError(`${at}: name da 1 a 100 caratteri`);
    if (!validRedirectUri(e["redirectUri"])) throw new PluginConfigError(`${at}: redirectUri non valido`);
    if (typeof e["secretSha256"] !== "string" || !SHA256_RE.test(e["secretSha256"])) throw new PluginConfigError(`${at}: secretSha256 non valido`);
    return { clientId: e["clientId"], name: e["name"], redirectUri: e["redirectUri"], secretSha256: e["secretSha256"] };
  });
}

export function pluginClient(clientId: string): PluginClient | null {
  return pluginClients().find((c) => c.clientId === clientId) ?? null;
}

export function pluginSecretMatches(client: PluginClient, secret: string): boolean {
  // Confronto tra hash di pari lunghezza, a tempo costante
  const a = Buffer.from(sha256Hex(secret), "hex");
  const b = Buffer.from(client.secretSha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Riga di `oauth_clients` del client plugin: creata o aggiornata (nome, indirizzo di ritorno, tipo). */
export async function ensurePluginClientRow(client: PluginClient): Promise<OAuthClient> {
  const [row] = await db
    .insert(oauthClientsTable)
    .values({ clientId: client.clientId, kind: "plugin", name: client.name, redirectUris: [client.redirectUri] })
    .onConflictDoUpdate({
      target: oauthClientsTable.clientId,
      set: { name: client.name, redirectUris: [client.redirectUri], kind: "plugin" },
    })
    .returning();
  return row!;
}
