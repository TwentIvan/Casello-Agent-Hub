import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, usersTable } from "@workspace/db";

// Token personali su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true: utente di
// sviluppo). Il secondo utente si inserisce a mano nel DB e i suoi token si creano dal modulo.

const realFetch = globalThis.fetch;
let base: string;
let server: http.Server;
let saved: string | undefined;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await realFetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  saved = process.env["AUTH_DISABLED"];
  process.env["AUTH_DISABLED"] = "true";
  const { requireAuth } = await import("../lib/auth");
  const { createApiTokensRouter } = await import("./api-tokens");
  const { errorHandler } = await import("../middlewares/error-handler");
  ({ createApiToken } = await import("../lib/api-tokens"));
  const mini = express();
  mini.use(express.json());
  mini.use("/api", requireAuth, createApiTokensRouter());
  mini.use("/api", errorHandler);
  server = http.createServer(mini);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  if (saved === undefined) delete process.env["AUTH_DISABLED"];
  else process.env["AUTH_DISABLED"] = saved;
});

beforeEach(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

describe("token personali", () => {
  it("crea, elenca senza token né hash e revoca", async () => {
    const created = await api("POST", "/account/tokens", { name: "Portatile", expiresInDays: 30 });
    expect(created.status, created.text).toBe(201);
    expect(created.json.token).toMatch(/^cas_/);
    expect(created.json.info).toMatchObject({ name: "Portatile", lastUsedAt: null, revokedAt: null });

    const list = await api("GET", "/account/tokens");
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(1);
    expect(list.text).not.toContain(created.json.token);
    expect(list.text).not.toContain("tokenHash");
    expect(list.text).not.toContain("token_hash");
    expect(Object.keys(list.json[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "lastUsedAt", "name", "revokedAt"]);

    const del = await api("DELETE", `/account/tokens/${created.json.info.id}`);
    expect(del.status).toBe(204);
    const after = await api("GET", "/account/tokens");
    expect(after.json[0].revokedAt).not.toBeNull();
    // già revocato: 404
    expect((await api("DELETE", `/account/tokens/${created.json.info.id}`)).status).toBe(404);
  });

  it("rifiuta con 400 giorni fuori intervallo e nome vuoto", async () => {
    expect((await api("POST", "/account/tokens", { name: "x", expiresInDays: 0 })).status).toBe(400);
    expect((await api("POST", "/account/tokens", { name: "x", expiresInDays: 91 })).status).toBe(400);
    expect((await api("POST", "/account/tokens", { name: "x", expiresInDays: 1.5 })).status).toBe(400);
    expect((await api("POST", "/account/tokens", { name: "   ", expiresInDays: 30 })).status).toBe(400);
  });

  it("un altro utente riceve 404 sulla revoca e non vede i token", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const { row } = await createApiToken(other!.id, "Altrui", 30);
    expect((await api("DELETE", `/account/tokens/${row.id}`)).status).toBe(404);
    const list = await api("GET", "/account/tokens");
    expect(list.json).toEqual([]);
  });
});
