import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, usersTable } from "@workspace/db";
import { approve } from "../lib/oauth/authorize";
import { registerClient } from "../lib/oauth/clients";

// POST /oauth/token sull'app completa. Il limite per client_id ha il suo file (oauth-token-limit.test.ts).

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"];
const saved: Record<string, string | undefined> = {};
const CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(60);
let base: string;
let server: http.Server;

async function token(body: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { res, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: "https://casello.example.test/",
  });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients, users RESTART IDENTITY CASCADE");
});

describe("POST /oauth/token", () => {
  it("scambio e rinnovo via HTTP; risposte con Cache-Control no-store", async () => {
    const [u] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning({ id: usersTable.id });
    const reg = await registerClient({ redirect_uris: [CB], client_name: "Claude" });
    const clientId = (reg.body as { client_id: string }).client_id;
    const rows = (await pool.query("SELECT id FROM oauth_clients WHERE client_id = $1", [clientId])).rows as { id: number }[];
    const url = new URL(
      await approve(u!.id, {
        clientId,
        clientRowId: rows[0]!.id,
        clientKind: "dcr",
        displayHost: "claude.ai",
        clientName: "Claude",
        redirectUri: CB,
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        state: null,
      }),
    );
    const a = await token({ grant_type: "authorization_code", code: url.searchParams.get("code")!, redirect_uri: CB, client_id: clientId, code_verifier: VERIFIER });
    expect(a.res.status).toBe(200);
    expect(a.res.headers.get("cache-control")).toBe("no-store");
    expect(a.json).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    const b = await token({ grant_type: "refresh_token", refresh_token: a.json["refresh_token"] as string, client_id: clientId });
    expect(b.res.status).toBe(200);
    const c = await token({ grant_type: "refresh_token", refresh_token: a.json["refresh_token"] as string, client_id: clientId });
    expect(c.res.status).toBe(400);
    expect(c.json["error"]).toBe("invalid_grant");
    expect(c.res.headers.get("cache-control")).toBe("no-store");
  });

  it("grant_type sconosciuto o mancante → unsupported_grant_type / invalid_request, no-store", async () => {
    const a = await token({ grant_type: "password", client_id: "x" });
    expect(a.res.status).toBe(400);
    expect(a.json["error"]).toBe("unsupported_grant_type");
    expect(a.res.headers.get("cache-control")).toBe("no-store");
    const b = await token({ client_id: "x" });
    expect(b.json["error"]).toBe("invalid_request");
  });

  it("client sconosciuto → 401 invalid_client", async () => {
    const r = await token({ grant_type: "refresh_token", refresh_token: "car_x", client_id: "cac_nope" });
    expect(r.res.status).toBe(401);
    expect(r.json["error"]).toBe("invalid_client");
  });
});
