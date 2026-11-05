import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

// File a sé: il contatore per IP è in memoria e le 21 richieste non devono toccare gli altri test.

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
  await pool.query("TRUNCATE oauth_clients RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("limite di autorizzazione", () => {
  it("21ª richiesta nel minuto → 429", async () => {
    const authorize = () => fetch(`${base}/oauth/authorize?client_id=cac_nonesiste`, { redirect: "manual" });
    for (let i = 0; i < 20; i++) expect((await authorize()).status).toBe(400);
    const last = await authorize();
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).not.toBeNull();
  });
});
