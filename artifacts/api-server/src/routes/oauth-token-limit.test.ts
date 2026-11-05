import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// File a sé: il contatore per client_id è in memoria e le 31 richieste non devono toccare gli altri test.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost", CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("limite del token endpoint", () => {
  it("31ª richiesta nel minuto per lo stesso client_id → 429 slow_down; un altro client_id passa", async () => {
    const call = (clientId: string) =>
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: clientId }).toString(),
      });
    for (let i = 0; i < 30; i++) expect((await call("cac_a")).status).toBe(400);
    const last = await call("cac_a");
    expect(last.status).toBe(429);
    expect(await last.json()).toMatchObject({ error: "slow_down" });
    expect(last.headers.get("retry-after")).not.toBeNull();
    expect((await call("cac_b")).status).toBe(400);
  });
});
