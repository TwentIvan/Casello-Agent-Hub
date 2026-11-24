import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditEventsTable, db, pool, usersTable } from "@workspace/db";

// Registro delle azioni su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true: utente di sviluppo):
// il middleware scrive gli eventi delle route sensibili riuscite, la route li elenca solo all'utente.

const realFetch = globalThis.fetch;
let base: string;
let server: http.Server;
let saved: string | undefined;
let recordAudit: typeof import("../lib/audit/record").recordAudit;
let sweepAuditEvents: typeof import("../lib/audit/record").sweepAuditEvents;

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

/** Gli eventi si scrivono a risposta inviata: si aspetta che compaiano. */
async function eventsWhen(count: number) {
  for (let i = 0; i < 50; i++) {
    const page = await api("GET", "/account/audit-events");
    if (page.json.events.length >= count) return page;
    await new Promise((r) => setTimeout(r, 20));
  }
  return api("GET", "/account/audit-events");
}

beforeAll(async () => {
  saved = process.env["AUTH_DISABLED"];
  process.env["AUTH_DISABLED"] = "true";
  const { requireAuth } = await import("../lib/auth");
  const { createApiTokensRouter } = await import("./api-tokens");
  const { createAuditEventsRouter } = await import("./audit-events");
  const { auditRoutes } = await import("../lib/audit/record");
  const { errorHandler } = await import("../middlewares/error-handler");
  ({ recordAudit, sweepAuditEvents } = await import("../lib/audit/record"));
  const mini = express();
  mini.set("trust proxy", true);
  mini.use(express.json());
  mini.use("/api", requireAuth, auditRoutes(), createApiTokensRouter(), createAuditEventsRouter());
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

describe("registro delle azioni", () => {
  it("creazione e revoca di un token lasciano due eventi senza il valore del token", async () => {
    const created = await api("POST", "/account/tokens", { name: "Script", expiresInDays: 30, scopes: ["api:read"] });
    expect(created.status, created.text).toBe(201);
    const id = created.json.info.id as number;
    expect((await api("DELETE", `/account/tokens/${id}`)).status).toBe(204);
    // Revoca non riuscita (già revocato): nessun evento
    expect((await api("DELETE", `/account/tokens/${id}`)).status).toBe(404);

    const page = await eventsWhen(2);
    expect(page.status).toBe(200);
    expect(page.json.events.map((e: { action: string }) => e.action)).toEqual(["api_token.revoke", "api_token.create"]);
    expect(page.json.events[1]).toMatchObject({
      objectType: "api_token",
      objectId: String(id),
      detail: { scopes: ["api:read"] },
      via: "session",
      tokenId: null,
    });
    expect(page.json.events[1].ip).toBeTruthy();
    expect(page.text).not.toContain(created.json.token);
    expect(page.json.nextBefore).toBeNull();
  });

  it("elenca solo gli eventi dell'utente, a pagine", async () => {
    await api("GET", "/account/audit-events"); // crea l'utente di sviluppo
    const [me] = await db.select().from(usersTable);
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    for (let i = 0; i < 3; i++) await recordAudit({ userId: me!.id, action: "auth.login", via: "session", detail: { provider: "google" } });
    await recordAudit({ userId: other!.id, action: "auth.login", via: "session" });

    const first = await api("GET", "/account/audit-events?limit=2");
    expect(first.json.events).toHaveLength(2);
    expect(first.json.nextBefore).toBe(first.json.events[1].id);
    const second = await api("GET", `/account/audit-events?limit=2&before=${first.json.nextBefore}`);
    expect(second.json.events).toHaveLength(1);
    expect(second.json.nextBefore).toBeNull();
    expect((await api("GET", "/account/audit-events?limit=500")).status).toBe(400);
  });

  it("il dettaglio non conserva credenziali e la pulizia toglie gli eventi vecchi", async () => {
    await api("GET", "/account/audit-events");
    const [me] = await db.select().from(usersTable);
    await recordAudit({
      userId: me!.id,
      action: "app.update",
      objectId: "sk-abcdefghijklmnopqrstuvwxyz",
      detail: { note: "ghp_abcdefghijklmnopqrstuvwxyz0123", ok: true },
      via: "token",
      tokenId: 3,
    });
    const page = await eventsWhen(1);
    expect(page.json.events[0]).toMatchObject({ objectId: "***", detail: { note: "***", ok: true }, via: "token", tokenId: 3 });

    await db.insert(auditEventsTable).values({ userId: me!.id, action: "auth.login", via: "session", createdAt: new Date("2020-01-01T00:00:00Z") });
    expect(await sweepAuditEvents()).toBe(1);
    expect((await api("GET", "/account/audit-events")).json.events).toHaveLength(1);
  });
});
