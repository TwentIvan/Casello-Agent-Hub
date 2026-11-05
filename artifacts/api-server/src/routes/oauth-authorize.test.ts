import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, oauthClientsTable, oauthCodesTable, oauthGrantsTable, pool } from "@workspace/db";

// Autorizzazione OAuth sull'app completa: pagina di consenso, decisione, errori. L'utente è quello di sviluppo
// (AUTH_DISABLED); il caso «senza sessione» passa da un mock di sessionUserId.

const state = vi.hoisted(() => ({ noUser: false }));
vi.mock("../lib/auth", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/auth")>();
  return { ...orig, sessionUserId: (req: Parameters<typeof orig.sessionUserId>[0]) => (state.noUser ? Promise.resolve(null) : orig.sessionUserId(req)) };
});

// Il limite di 20/min ha il suo file (oauth-authorize-limit.test.ts): qui il contatore per IP non deve scattare.
vi.mock("../middlewares/rate-limit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../middlewares/rate-limit")>();
  return { ...orig, oauthAuthorizeRateLimit: (_req: unknown, _res: unknown, next: () => void) => next() };
});

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
const CB = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
let base: string;
let server: http.Server;
let clientId: string;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: "https://casello.example.test",
  });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  state.noUser = false;
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
  const [c] = await db
    .insert(oauthClientsTable)
    .values({ clientId: "cac_test", kind: "dcr", name: "Claude", redirectUris: [CB] })
    .returning();
  clientId = c!.clientId;
});

function authQuery(over: Record<string, string | undefined> = {}): string {
  const p: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CB,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1",
    ...over,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) qs.set(k, v);
  return `/oauth/authorize?${qs.toString()}`;
}

async function get(path: string): Promise<{ res: Response; text: string; cookie: string }> {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  const text = await res.text();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { res, text, cookie };
}

async function post(cookie: string, form: Record<string, string>): Promise<{ res: Response; text: string }> {
  const res = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(form).toString(),
  });
  return { res, text: await res.text() };
}

function csrfOf(html: string): string {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("GET /oauth/authorize", () => {
  it("senza sessione → 302 al login con returnTo che riporta qui", async () => {
    state.noUser = true;
    const path = authQuery();
    const { res } = await get(path);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toBe(`/api/auth/login?returnTo=${encodeURIComponent(path)}`);
    const { safeReturnTo } = await import("../lib/auth");
    expect(safeReturnTo(new URL(loc, "http://x").searchParams.get("returnTo"))).toBe(path);
  });

  it("consenso: 200 con nome del client, host claude.ai, email; CSP e X-Frame-Options DENY", async () => {
    const { res, text } = await get(authQuery());
    expect(res.status).toBe(200);
    expect(text).toContain("Claude");
    expect(text).toContain("claude.ai");
    expect(text).toContain("dev@localhost");
    expect(text).toContain("Consenti");
    expect(text).toContain("Annulla");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action");
  });

  it("client_name con <script> è escapato nella pagina", async () => {
    await db.update(oauthClientsTable).set({ name: "<script>alert(1)</script>" }).where(eq(oauthClientsTable.clientId, clientId));
    const { text } = await get(authQuery());
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("client sconosciuto o redirect non registrato → pagina 400, nessuna Location", async () => {
    for (const q of [authQuery({ client_id: "cac_nonesiste" }), authQuery({ redirect_uri: "https://evil.example/cb" })]) {
      const { res, text } = await get(q);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(text).toContain("<html");
    }
  });

  it("resource diversa → 302 con error=invalid_target", async () => {
    const { res } = await get(authQuery({ resource: "https://altro.example/mcp" }));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("error")).toBe("invalid_target");
    expect(loc.searchParams.get("state")).toBe("st-1");
  });

  it("resource uguale a <base>/mcp è accettata", async () => {
    const { res } = await get(authQuery({ resource: "https://casello.example.test/mcp", scope: "mcp" }));
    expect(res.status).toBe(200);
  });

  it("senza code_challenge o metodo plain → invalid_request; scope e response_type sbagliati", async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ code_challenge: undefined }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ scope: "admin" }, "invalid_scope"],
      [{ response_type: "token" }, "unsupported_response_type"],
    ];
    for (const [over, code] of cases) {
      const { res } = await get(authQuery(over));
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe(code);
    }
  });
});

describe("POST /oauth/authorize", () => {
  it("Consenti → 302 al ritorno con code e state; collegamento e codice creati", async () => {
    const { text, cookie } = await get(authQuery());
    const { res } = await post(cookie, { csrf: csrfOf(text), decision: "allow" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(loc.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const grants = await db.select().from(oauthGrantsTable);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toEqual(["mcp", "api:write"]);
    const codes = await db.select().from(oauthCodesTable);
    expect(codes).toHaveLength(1);
    expect(codes[0]!.codeHash).not.toBe(loc.searchParams.get("code"));
    expect(codes[0]!.redirectUri).toBe(CB);
    expect(codes[0]!.codeChallenge).toBe(CHALLENGE);
    expect(codes[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    // la richiesta in attesa è consumata
    const again = await post(cookie, { csrf: csrfOf(text), decision: "allow" });
    expect(again.res.status).toBe(400);
  });

  it("un nuovo consenso revoca il collegamento precedente", async () => {
    for (let i = 0; i < 2; i++) {
      const { text, cookie } = await get(authQuery());
      await post(cookie, { csrf: csrfOf(text), decision: "allow" });
    }
    const grants = await db.select().from(oauthGrantsTable).orderBy(oauthGrantsTable.id);
    expect(grants).toHaveLength(2);
    expect(grants[0]!.revokedAt).not.toBeNull();
    expect(grants[1]!.revokedAt).toBeNull();
  });

  it("Annulla → access_denied con state, nessun collegamento", async () => {
    const { text, cookie } = await get(authQuery());
    const { res } = await post(cookie, { csrf: csrfOf(text), decision: "deny" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-1");
    expect(await db.select().from(oauthGrantsTable)).toHaveLength(0);
  });

  it("senza state il ritorno non lo riporta", async () => {
    const { text, cookie } = await get(authQuery({ state: undefined }));
    const { res } = await post(cookie, { csrf: csrfOf(text), decision: "deny" });
    expect(new URL(res.headers.get("location")!).searchParams.has("state")).toBe(false);
  });

  it("POST con csrf sbagliato o senza richiesta in attesa → pagina «Richiesta scaduta: ricomincia dall'app Claude»", async () => {
    const { text, cookie } = await get(authQuery());
    const wrong = await post(cookie, { csrf: "x".repeat(43), decision: "allow" });
    expect(wrong.res.status).toBe(400);
    expect(wrong.text).toContain("Richiesta scaduta: ricomincia dall&#39;app Claude");
    const none = await post("", { csrf: csrfOf(text), decision: "allow" });
    expect(none.res.status).toBe(400);
    expect(none.text).toContain("Richiesta scaduta: ricomincia dall&#39;app Claude");
    const noCsrf = await post(cookie, { decision: "allow" });
    expect(noCsrf.res.status).toBe(400);
    expect(await db.select().from(oauthGrantsTable)).toHaveLength(0);
  });
});
