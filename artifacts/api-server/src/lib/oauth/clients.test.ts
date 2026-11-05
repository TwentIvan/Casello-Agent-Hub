import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, oauthClientsTable, pool } from "@workspace/db";
import { isAllowedRedirectUri, redirectMatches, registerClient, resolveClient } from "./clients";
import { OAuthError } from "./errors";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const DOC_URL = "https://client.example.com/oauth/metadata.json";

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});
afterAll(async () => {
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});

function docFetch(body: string | object, init: ResponseInit = {}): typeof fetch {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return (async () => new Response(text, { status: 200, ...init })) as unknown as typeof fetch;
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
    const boom = (async () => {
      throw new Error("non deve scaricare");
    }) as unknown as typeof fetch;
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
    const counting = (async () => {
      calls++;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect((await resolveClient(DOC_URL, counting))?.name).toBe("App di prova");
    expect(calls).toBe(0);

    // dopo 24 h si riscarica e aggiorna
    await pool.query("UPDATE oauth_clients SET metadata_fetched_at = now() - interval '25 hours'");
    const again = await resolveClient(DOC_URL, docFetch({ ...doc, client_name: "Nuovo nome" }));
    expect(again?.name).toBe("Nuovo nome");
    const rows = await db.select().from(oauthClientsTable);
    expect(rows).toHaveLength(1);
  });

  it("documento non valido → null (client_id diverso, redirect HTTP, oltre 64 KB, host privato, errore, non JSON)", async () => {
    const good = { client_id: DOC_URL, client_name: "x", redirect_uris: [CLAUDE_CB] };
    expect(await resolveClient(DOC_URL, docFetch({ ...good, client_id: "https://altro.example/x" }))).toBeNull();
    expect(await resolveClient(DOC_URL, docFetch({ ...good, redirect_uris: ["http://client.example.com/cb"] }))).toBeNull();
    expect(await resolveClient(DOC_URL, docFetch({ ...good, client_name: "x".repeat(70 * 1024) }))).toBeNull();
    expect(await resolveClient(DOC_URL, docFetch("non json"))).toBeNull();
    expect(await resolveClient(DOC_URL, docFetch(good, { status: 500 }))).toBeNull();
    expect(
      await resolveClient(DOC_URL, (async () => {
        throw new Error("redirect");
      }) as unknown as typeof fetch),
    ).toBeNull();

    for (const host of ["http://10.0.0.5/c.json", "https://10.0.0.5/c.json", "https://localhost/c.json", "https://169.254.169.254/c.json"]) {
      let called = false;
      const f = (async () => {
        called = true;
        return new Response(JSON.stringify({ client_id: host, redirect_uris: [CLAUDE_CB] }));
      }) as unknown as typeof fetch;
      expect(await resolveClient(host, f), host).toBeNull();
      expect(called, host).toBe(false);
    }
    expect(await db.select().from(oauthClientsTable)).toHaveLength(0);
  });
});
