import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, oauthClientsTable, type OAuthClient } from "@workspace/db";
import { validateBaseUrl } from "../ai/providers";
import { logger } from "../logger";
import { OAuthError } from "./errors";

const FIXED_REDIRECTS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1):(\d{1,5})\/callback$/;
export const MAX_CLIENTS = 1000;
const MAX_REDIRECTS = 5;
const MAX_NAME = 100;
const DOC_TIMEOUT_MS = 10_000;
const DOC_MAX_BYTES = 64 * 1024;
const DOC_TTL_MS = 24 * 60 * 60 * 1000;

function loopbackParts(uri: string): { host: string; port: number } | null {
  const m = LOOPBACK.exec(uri);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1]!, port };
}

/** Indirizzo di ritorno ammesso: i due di Claude (uguali carattere per carattere) o il loopback con porta qualsiasi. */
export function isAllowedRedirectUri(uri: string): boolean {
  return typeof uri === "string" && (FIXED_REDIRECTS.has(uri) || loopbackParts(uri) !== null);
}

/** `uri` corrisponde a uno dei registrati: identico, oppure loopback con la stessa macchina e un'altra porta (RFC 8252). */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return FIXED_REDIRECTS.has(uri) || loopbackParts(uri) !== null;
  const want = loopbackParts(uri);
  if (!want) return false;
  return registered.some((r) => {
    const have = loopbackParts(r);
    return have !== null && have.host === want.host;
  });
}

function parseRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REDIRECTS || !value.every((v) => typeof v === "string")) {
    throw new OAuthError("invalid_client_metadata", "redirect_uris deve contenere da 1 a 5 indirizzi");
  }
  const uris = value as string[];
  if (!uris.every(isAllowedRedirectUri)) throw new OAuthError("invalid_redirect_uri", "indirizzo di ritorno non ammesso");
  return uris;
}

/** Registrazione dinamica dei client (RFC 7591): solo client pubblici. */
export async function registerClient(body: unknown): Promise<{ status: 201; body: object }> {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const redirectUris = parseRedirectUris(b["redirect_uris"]);
  const method = b["token_endpoint_auth_method"];
  if (method !== undefined && method !== "none") {
    throw new OAuthError("invalid_client_metadata", "sono ammessi solo client pubblici (token_endpoint_auth_method none)");
  }
  const rawName = b["client_name"];
  if (rawName !== undefined && typeof rawName !== "string") {
    throw new OAuthError("invalid_client_metadata", "client_name non valido");
  }
  const name = rawName === undefined || rawName.trim() === "" ? "Client MCP" : rawName.trim();
  if (name.length > MAX_NAME) throw new OAuthError("invalid_client_metadata", "client_name troppo lungo (massimo 100 caratteri)");

  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(oauthClientsTable);
  if (n >= MAX_CLIENTS) throw new OAuthError("temporarily_unavailable", "registrazioni temporaneamente sospese", 503);

  const clientId = `cac_${randomBytes(16).toString("base64url")}`;
  await db.insert(oauthClientsTable).values({ clientId, kind: "dcr", name, redirectUris });
  logger.info({ clientId, name }, "client OAuth registrato");
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
  };
}

async function readLimited(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchClientDocument(
  clientId: string,
  fetchImpl: typeof fetch,
): Promise<{ name: string; redirectUris: string[] } | null> {
  if (validateBaseUrl(clientId, false) !== null) return null;
  const res = await fetchImpl(clientId, {
    redirect: "error",
    signal: AbortSignal.timeout(DOC_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const text = await readLimited(res, DOC_MAX_BYTES);
  if (text === null) return null;
  const doc: unknown = JSON.parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d["client_id"] !== clientId) return null;
  const uris = d["redirect_uris"];
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECTS || !uris.every((u) => typeof u === "string" && isAllowedRedirectUri(u))) {
    return null;
  }
  const rawName = d["client_name"];
  const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim().slice(0, MAX_NAME) : "Client MCP";
  return { name, redirectUris: uris as string[] };
}

/** Trova il client: riga `dcr`, oppure documento del client per un `client_id` https (salvato e riscaricato dopo 24 ore). */
export async function resolveClient(clientId: string, fetchImpl: typeof fetch = fetch): Promise<OAuthClient | null> {
  try {
    const [row] = await db.select().from(oauthClientsTable).where(eq(oauthClientsTable.clientId, clientId));
    if (row?.kind === "dcr") return row;
    if (!clientId.startsWith("https://")) return null;
    if (row?.metadataFetchedAt && Date.now() - row.metadataFetchedAt.getTime() < DOC_TTL_MS) return row;

    const doc = await fetchClientDocument(clientId, fetchImpl);
    if (!doc) return null;
    const now = new Date();
    const [saved] = await db
      .insert(oauthClientsTable)
      .values({ clientId, kind: "metadata", name: doc.name, redirectUris: doc.redirectUris, metadataFetchedAt: now })
      .onConflictDoUpdate({
        target: oauthClientsTable.clientId,
        set: { name: doc.name, redirectUris: doc.redirectUris, metadataFetchedAt: now },
      })
      .returning();
    return saved ?? null;
  } catch {
    return null;
  }
}
