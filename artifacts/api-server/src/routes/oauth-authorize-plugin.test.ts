import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, oauthGrantsTable, pool } from "@workspace/db";

// Consenso OAuth per i client plugin (The Hub Up): pagina, controlli, collegamento con gli ambiti api.

vi.mock("../middlewares/rate-limit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../middlewares/rate-limit")>();
  return { ...orig, oauthAuthorizeRateLimit: (_req: unknown, _res: unknown, next: () => void) => next() };
});

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "OAUTH_PLUGIN_CLIENTS"];
const saved: Record<string, string | undefined> = {};
const ISSUER = "https://casello.example.test";
const CB = "https://hubup.example.test/botcave/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CONFIG = JSON.stringify([
  { clientId: "hubup", name: "The Hub Up", redirectUri: CB, secretSha256: createHash("sha256").update("segreto").digest("hex") },
]);
let base: string;
let server: http.Server;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: ISSUER,
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
  process.env["OAUTH_PLUGIN_CLIENTS"] = CONFIG;
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
});

function authPath(over: Record<string, string | undefined> = {}): string {
  const p: Record<string, string | undefined> = {
    response_type: "code",
    client_id: "hubup",
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

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  const text = await res.text();
  return { res, text, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("autorizzazione dei client plugin", () => {
  it("pagina di consenso con titolo e testo del plugin", async () => {
    const { res, text } = await get(authPath());
    expect(res.status).toBe(200);
    expect(text).toContain("Collegare The Hub Up");
    expect(text).toContain("a Botcave?");
    expect(text).toContain("Non potrà cambiare chiavi");
    expect(res.headers.get("content-security-policy")).toContain("https://hubup.example.test");
  });

  it("redirect_uri diverso → 400 senza redirect", async () => {
    const { res, text } = await get(authPath({ redirect_uri: `${CB}/altro` }));
    expect(res.status).toBe(400);
    expect(text).toContain("Indirizzo di ritorno non valido.");
    expect(res.headers.get("location")).toBeNull();
  });

  it("scope: mcp → invalid_scope, api:read ammesso", async () => {
    const bad = await get(authPath({ scope: "mcp" }));
    expect(bad.res.status).toBe(302);
    expect(new URL(bad.res.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
    const ok = await get(authPath({ scope: "api:read" }));
    expect(ok.res.status).toBe(200);
  });

  it("resource: /mcp → invalid_target, /api/ ammesso", async () => {
    const bad = await get(authPath({ resource: `${ISSUER}/mcp` }));
    expect(new URL(bad.res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const ok = await get(authPath({ resource: `${ISSUER}/api/` }));
    expect(ok.res.status).toBe(200);
  });

  it("allow → codice e collegamento con gli ambiti api", async () => {
    const { text, cookie } = await get(authPath());
    const csrf = /name="csrf" value="([^"]+)"/.exec(text)![1]!;
    const res = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CB);
    expect(loc.searchParams.get("code")).toBeTruthy();
    const grants = await db.select().from(oauthGrantsTable);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes).toEqual(["api:read", "api:write"]);
  });

  it("plugin tolto dopo il consenso mostrato → POST allow 400, nessun collegamento", async () => {
    const { text, cookie } = await get(authPath());
    const csrf = /name="csrf" value="([^"]+)"/.exec(text)![1]!;
    process.env["OAUTH_PLUGIN_CLIENTS"] = "[]";
    const res = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Applicazione non riconosciuta.");
    expect(res.headers.get("location")).toBeNull();
    expect(await db.select().from(oauthGrantsTable)).toHaveLength(0);
  });

  it("plugin tolto dalla configurazione → Applicazione non riconosciuta", async () => {
    await get(authPath());
    process.env["OAUTH_PLUGIN_CLIENTS"] = "[]";
    const { res, text } = await get(authPath());
    expect(res.status).toBe(400);
    expect(text).toContain("Applicazione non riconosciuta.");
  });
});
