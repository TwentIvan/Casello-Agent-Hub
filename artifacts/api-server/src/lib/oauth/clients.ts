import { randomBytes } from "node:crypto";
import dns from "node:dns";
import type http from "node:http";
import https from "node:https";
import { eq, sql } from "drizzle-orm";
import { db, oauthClientsTable, type OAuthClient } from "@workspace/db";
import { isPublicIp, validateBaseUrl } from "../ai/providers";
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

/** Tutti i client (dcr e metadata): il tetto di 1 000 li conta insieme. */
async function countClients(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(oauthClientsTable);
  return row?.n ?? 0;
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

  if ((await countClients()) >= MAX_CLIENTS) throw new OAuthError("temporarily_unavailable", "registrazioni temporaneamente sospese", 503);

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

export type DocumentDownloader = (url: string) => Promise<string | null>;
type Resolver = (host: string, opts: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>;
type RequestFn = (url: URL, opts: https.RequestOptions) => http.ClientRequest;

/**
 * Funzione `lookup` per il socket: risolve il nome, rifiuta se UNO QUALSIASI degli indirizzi non è pubblico e
 * consegna al socket proprio gli indirizzi verificati (niente seconda risoluzione: nessun DNS rebinding).
 */
export function guardedLookup(resolve: Resolver = (h, o) => dns.promises.lookup(h, o)) {
  return (host: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void): void => {
    resolve(host, { all: true, family: options?.family, hints: options?.hints }).then(
      (addrs) => {
        if (addrs.length === 0 || !addrs.every((a) => isPublicIp(a.address))) {
          cb(new Error("indirizzo non ammesso"));
          return;
        }
        if (options?.all) cb(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      },
      (err: unknown) => cb(err),
    );
  };
}

/**
 * Scarica il documento del client: solo https verso indirizzi pubblici (verificati alla connessione), nessun redirect,
 * 10 s in tutto, al massimo 64 KB. Qualsiasi problema → null.
 */
export function downloadClientDocument(
  url: string,
  deps: { lookup?: ReturnType<typeof guardedLookup>; request?: RequestFn } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    if (target.protocol !== "https:") {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const doRequest: RequestFn = deps.request ?? ((u, o) => https.request(u, o));
    const req = doRequest(target, {
      method: "GET",
      headers: { accept: "application/json" },
      lookup: (deps.lookup ?? guardedLookup()) as unknown as https.RequestOptions["lookup"],
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(null);
    }, DOC_TIMEOUT_MS);
    req.on("error", () => finish(null));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.destroy();
        finish(null);
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > DOC_MAX_BYTES) {
          res.destroy();
          req.destroy();
          finish(null);
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => finish(null));
    });
    req.end();
  });
}

async function fetchClientDocument(
  clientId: string,
  download: DocumentDownloader,
): Promise<{ name: string; redirectUris: string[] } | null> {
  if (validateBaseUrl(clientId, false) !== null) return null;
  const text = await download(clientId);
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
export async function resolveClient(clientId: string, download: DocumentDownloader = downloadClientDocument): Promise<OAuthClient | null> {
  try {
    const [row] = await db.select().from(oauthClientsTable).where(eq(oauthClientsTable.clientId, clientId));
    if (row?.kind === "dcr") return row;
    if (!clientId.startsWith("https://")) return null;
    if (row?.metadataFetchedAt && Date.now() - row.metadataFetchedAt.getTime() < DOC_TTL_MS) return row;

    if (!row && (await countClients()) >= MAX_CLIENTS) return null;
    const doc = await fetchClientDocument(clientId, download);
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
  } catch (err) {
    logger.warn({ errName: err instanceof Error ? err.name : "unknown" }, "Client OAuth non risolto");
    return null;
  }
}
