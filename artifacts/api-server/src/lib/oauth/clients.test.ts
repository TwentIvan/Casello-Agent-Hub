import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, oauthClientsTable, pool } from "@workspace/db";
import {
  downloadClientDocument,
  guardedLookup,
  isAllowedRedirectUri,
  redirectMatches,
  registerClient,
  resolveClient,
  type DocumentDownloader,
} from "./clients";
import { OAuthError } from "./errors";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const DOC_URL = "https://client.example.com/oauth/metadata.json";

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});
afterAll(async () => {
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});

function docFetch(body: string | object): DocumentDownloader {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return async () => text;
}

describe("indirizzi di ritorno", () => {
  it("ammette solo quelli di Claude e il loopback con /callback", () => {
    expect(isAllowedRedirectUri(CLAUDE_CB)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:1/callback")).toBe(true);
    expect(isAllowedRedirectUri("https://evil.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback/x")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost/altro")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost:70000/callback")).toBe(false);
  });

  it("loopback: registrato :33418, ammesso anche :51000; https://claude.ai mai a porta diversa", () => {
    expect(redirectMatches(["http://localhost:33418/callback"], "http://localhost:51000/callback")).toBe(true);
    expect(redirectMatches(["http://localhost:33418/callback"], "http://127.0.0.1:51000/callback")).toBe(false);
    expect(redirectMatches([CLAUDE_CB], CLAUDE_CB)).toBe(true);
    expect(redirectMatches([CLAUDE_CB], "https://claude.ai:8443/api/mcp/auth_callback")).toBe(false);
    expect(redirectMatches([CLAUDE_CB], "https://claude.com/api/mcp/auth_callback")).toBe(false);
  });
});

describe("registrazione", () => {
  it("registra un client claude.ai: 201 con client_id cac_…", async () => {
    const out = await registerClient({ redirect_uris: [CLAUDE_CB], client_name: "Claude" });
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none" });
    const id = (out.body as { client_id: string }).client_id;
    expect(id).toMatch(/^cac_/);
    const [row] = await db.select().from(oauthClientsTable).where(eq(oauthClientsTable.clientId, id));
    expect(row).toMatchObject({ kind: "dcr", name: "Claude", redirectUris: [CLAUDE_CB] });
  });

  it("nome assente: «Client MCP»; nome oltre 100 caratteri → invalid_client_metadata", async () => {
    const out = await registerClient({ redirect_uris: [CLAUDE_CB] });
    expect(out.body).toMatchObject({ client_name: "Client MCP" });
    await expect(registerClient({ redirect_uris: [CLAUDE_CB], client_name: "x".repeat(101) })).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
  });

  it("redirect estraneo → invalid_redirect_uri", async () => {
    for (const uri of ["https://evil.example/cb", "https://claude.ai/api/mcp/auth_callback/x", "http://localhost/altro"]) {
      await expect(registerClient({ redirect_uris: [uri] })).rejects.toMatchObject({ code: "invalid_redirect_uri", status: 400 });
    }
  });

  it("client_secret_post → invalid_client_metadata; più di 5 redirect o nessuno → 400", async () => {
    await expect(
      registerClient({ redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: "client_secret_post" }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
    const six = Array.from({ length: 6 }, (_, i) => `http://localhost:${3000 + i}/callback`);
    await expect(registerClient({ redirect_uris: six })).rejects.toBeInstanceOf(OAuthError);
    await expect(registerClient({ redirect_uris: [] })).rejects.toMatchObject({ code: "invalid_client_metadata" });
    await expect(registerClient(null)).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("oltre 1 000 client → 503", async () => {
    await pool.query(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris)
       SELECT 'cac_fill' || g, 'dcr', 'x', '[]'::jsonb FROM generate_series(1, 1000) g`,
    );
    await expect(registerClient({ redirect_uris: [CLAUDE_CB] })).rejects.toMatchObject({
      code: "temporarily_unavailable",
      status: 503,
      description: "registrazioni temporaneamente sospese",
    });
  });
});

describe("resolveClient", () => {
  it("trova un client dcr e non scarica nulla", async () => {
    const out = await registerClient({ redirect_uris: [CLAUDE_CB] });
    const id = (out.body as { client_id: string }).client_id;
    const boom: DocumentDownloader = async () => {
      throw new Error("non deve scaricare");
    };
    expect((await resolveClient(id, boom))?.clientId).toBe(id);
    expect(await resolveClient("cac_inesistente", boom)).toBeNull();
  });

  it("documento del client: scaricato, client_id coerente, redirect ammessi", async () => {
    const doc = { client_id: DOC_URL, client_name: "App di prova", redirect_uris: [CLAUDE_CB] };
    const client = await resolveClient(DOC_URL, docFetch(doc));
    expect(client).toMatchObject({ clientId: DOC_URL, kind: "metadata", name: "App di prova", redirectUris: [CLAUDE_CB] });
    expect(client?.metadataFetchedAt).toBeInstanceOf(Date);

    // entro 24 h non si riscarica
    let calls = 0;
    const counting: DocumentDownloader = async () => {
      calls++;
      return "{}";
    };
    expect((await resolveClient(DOC_URL, counting))?.name).toBe("App di prova");
    expect(calls).toBe(0);

    // dopo 24 h si riscarica e aggiorna
    await pool.query("UPDATE oauth_clients SET metadata_fetched_at = now() - interval '25 hours'");
    const again = await resolveClient(DOC_URL, docFetch({ ...doc, client_name: "Nuovo nome" }));
    expect(again?.name).toBe("Nuovo nome");
    const rows = await db.select().from(oauthClientsTable);
    expect(rows).toHaveLength(1);
  });

  it("documento non valido → null (client_id diverso, redirect HTTP, non JSON, errore di scarico)", async () => {
    const good = { client_id: DOC_URL, client_name: "x", redirect_uris: [CLAUDE_CB] };
    expect(await resolveClient(DOC_URL, docFetch({ ...good, client_id: "https://altro.example/x" }))).toBeNull();
    expect(await resolveClient(DOC_URL, docFetch({ ...good, redirect_uris: ["http://client.example.com/cb"] }))).toBeNull();
    expect(await resolveClient(DOC_URL, docFetch("non json"))).toBeNull();
    expect(await resolveClient(DOC_URL, async () => null)).toBeNull();
    expect(
      await resolveClient(DOC_URL, async () => {
        throw new Error("rete");
      }),
    ).toBeNull();

    for (const host of ["http://10.0.0.5/c.json", "https://10.0.0.5/c.json", "https://localhost/c.json", "https://169.254.169.254/c.json"]) {
      let called = false;
      const f: DocumentDownloader = async () => {
        called = true;
        return JSON.stringify({ client_id: host, redirect_uris: [CLAUDE_CB] });
      };
      expect(await resolveClient(host, f), host).toBeNull();
      expect(called, host).toBe(false);
    }
    expect(await db.select().from(oauthClientsTable)).toHaveLength(0);
  });

  it("oltre 1 000 client: un nuovo documento non si salva (null), uno già noto sì", async () => {
    await pool.query(
      `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris)
       SELECT 'https://m' || g || '.example.com/c', 'metadata', 'x', '[]'::jsonb FROM generate_series(1, 1000) g`,
    );
    const doc = { client_id: DOC_URL, client_name: "x", redirect_uris: [CLAUDE_CB] };
    expect(await resolveClient(DOC_URL, docFetch(doc))).toBeNull();
    await expect(registerClient({ redirect_uris: [CLAUDE_CB] })).rejects.toMatchObject({ status: 503 });
  });
});

// Protezione SSRF: la risoluzione del nome si controlla alla connessione, su tutti gli indirizzi.
function lookupOnce(host: string, addrs: string[], all = false): Promise<{ err: Error | null; res: unknown }> {
  const resolver = async () => addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
  return new Promise((resolve) =>
    guardedLookup(resolver)(host, { all }, (err: unknown, ...res: unknown[]) =>
      resolve({ err: (err as Error | null) ?? null, res }),
    ),
  );
}

describe("guardedLookup", () => {
  it("rifiuta se un indirizzo è privato, loopback, link-local, ULA, metadata o mappato", async () => {
    for (const addr of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "::ffff:10.0.0.1", "fd00:ec2::254", "fe80::1", "0.0.0.0"]) {
      expect((await lookupOnce("x.example.com", [addr])).err, addr).toBeInstanceOf(Error);
    }
    // basta un indirizzo non pubblico tra quelli restituiti
    expect((await lookupOnce("x.example.com", ["93.184.216.34", "10.0.0.5"], true)).err).toBeInstanceOf(Error);
  });

  it("indirizzi pubblici: li consegna al socket (anche con all)", async () => {
    expect(await lookupOnce("x.example.com", ["93.184.216.34"])).toEqual({ err: null, res: ["93.184.216.34", 4] });
    const all = await lookupOnce("x.example.com", ["93.184.216.34"], true);
    expect(all.err).toBeNull();
    expect(all.res).toEqual([[{ address: "93.184.216.34", family: 4 }]]);
  });
});

// Richiesta finta: chiama la `lookup` ricevuta e solo se va bene «si connette» e risponde.
function fakeRequest(opts: { status?: number; body?: string; connected: { n: number } }) {
  return (_url: URL, o: { lookup?: unknown }) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    req.destroy = () => undefined;
    req.end = () => {
      // la lookup ricevuta dal socket è quella che decide se ci si connette
      expect(typeof o.lookup).toBe("function");
      (o.lookup as ReturnType<typeof guardedLookup>)("x.example.com", {}, (err: unknown) => {
        if (err) {
          req.emit("error", err);
          return;
        }
        opts.connected.n++;
        const res = Readable.from([Buffer.from(opts.body ?? "{}")]) as Readable & { statusCode?: number };
        res.statusCode = opts.status ?? 200;
        req.emit("response", res);
      });
    };
    return req as never;
  };
}

const lookupTo = (addrs: string[]) =>
  guardedLookup(async () => addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })));

describe("downloadClientDocument", () => {
  const url = "https://x.example.com/c.json";

  it("host che si risolve in un indirizzo non pubblico → null e nessuna connessione", async () => {
    for (const addr of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "::ffff:10.0.0.1"]) {
      const connected = { n: 0 };
      const out = await downloadClientDocument(url, { lookup: lookupTo([addr]), request: fakeRequest({ connected }) });
      expect(out, addr).toBeNull();
      expect(connected.n, addr).toBe(0);
    }
  });

  it("indirizzo pubblico: si connette e legge il corpo", async () => {
    const connected = { n: 0 };
    const out = await downloadClientDocument(url, { lookup: lookupTo(["93.184.216.34"]), request: fakeRequest({ body: '{"a":1}', connected }) });
    expect(out).toBe('{"a":1}');
    expect(connected.n).toBe(1);
  });

  it("3xx, 5xx, oltre 64 KB, http → null", async () => {
    const connected = { n: 0 };
    const pub = ["93.184.216.34"];
    expect(await downloadClientDocument(url, { lookup: lookupTo(pub), request: fakeRequest({ status: 302, connected }) })).toBeNull();
    expect(await downloadClientDocument(url, { lookup: lookupTo(pub), request: fakeRequest({ status: 500, connected }) })).toBeNull();
    expect(await downloadClientDocument(url, { lookup: lookupTo(pub), request: fakeRequest({ body: "x".repeat(70 * 1024), connected }) })).toBeNull();
    expect(await downloadClientDocument("http://x.example.com/c.json", { lookup: lookupTo(pub), request: fakeRequest({ connected }) })).toBeNull();
  });
});
