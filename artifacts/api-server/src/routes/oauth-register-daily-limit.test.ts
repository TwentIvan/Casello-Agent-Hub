import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";

// File a sé: i contatori per IP sono in memoria e le 51 registrazioni non devono toccare gli altri test.

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

describe("tetto giornaliero di registrazione", () => {
  it("la 51ª registrazione del giorno per IP → 429, anche a minuti diversi", async () => {
    const t0 = Date.parse("2030-01-01T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const register = () =>
        fetch(`${base}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
        });
      for (let i = 0; i < 50; i++) {
        vi.setSystemTime(t0 + i * 61_000);
        expect((await register()).status, `registrazione ${i + 1}`).toBe(201);
      }
      vi.setSystemTime(t0 + 51 * 61_000);
      expect((await register()).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});
