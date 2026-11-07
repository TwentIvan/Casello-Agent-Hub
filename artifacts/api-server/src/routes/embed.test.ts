import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, appsTable, pool } from "@workspace/db";

const ENV_KEYS = ["EMBED_ALLOWED_ORIGINS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "AUTH_DISABLED"];
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env["AUTH_DISABLED"]; // login vero attivo: la route deve restare pubblica
  Object.assign(process.env, {
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: "https://casello.example.test",
    GOOGLE_CLIENT_ID: "test-id",
    GOOGLE_CLIENT_SECRET: "test-secret",
    SESSION_SECRET: "s".repeat(32),
  });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(async () => {
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  process.env["EMBED_ALLOWED_ORIGINS"] = "https://hubup.fantamister.cloud";
});

describe("GET /api/embed/config", () => {
  it("senza login: origine ammessa, nome = host", async () => {
    const r = await get("/api/embed/config?origin=https://hubup.fantamister.cloud");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ allowed: true, clientId: "embed:https://hubup.fantamister.cloud", appName: "hubup.fantamister.cloud" });
  });
  it("usa il nome dell'App con quella origine", async () => {
    await db.insert(appsTable).values({ name: "The Hub Up", slug: "hubup", baseUrl: "https://hubup.fantamister.cloud/api" });
    const r = await get("/api/embed/config?origin=https://hubup.fantamister.cloud");
    expect(r.json).toMatchObject({ allowed: true, appName: "The Hub Up" });
  });
  it("origine non in lista, mancante o non valida", async () => {
    const none = { allowed: false, clientId: null, appName: null };
    expect((await get("/api/embed/config?origin=https://evil.example")).json).toEqual(none);
    expect((await get("/api/embed/config")).json).toEqual(none);
    expect((await get("/api/embed/config?origin=non-un-url")).json).toEqual(none);
  });
});
