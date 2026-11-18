import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appsTable, db, pool, usersTable } from "@workspace/db";
import { createApiToken } from "../src/lib/api-tokens";

// PUT /api/apps/:id/page-actions: sessione sì, token agent e api:read no.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const DENIED = "il token non ha l'ambito per questa operazione";
let base: string;
let server: http.Server;
let appId: number;

async function put(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/apps/${appId}/page-actions`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: "dev@localhost", CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [row] = await db.insert(appsTable).values({ name: "Azioni", slug: "azioni-pagina", baseUrl: "https://azioni.example.com" }).returning();
  appId = row!.id;
  await db.insert(usersTable).values({ email: "dev@localhost" }).onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(appsTable).where(eq(appsTable.slug, "azioni-pagina"));
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await pool.end();
});

describe("PUT /apps/:id/page-actions", () => {
  const actions = [{ page: "task", label: " Esegui il task ", request: "Esegui il task corrente" }];

  it("sessione: 200 con pageActions normalizzate", async () => {
    const r = await put({ actions });
    expect(r.status).toBe(200);
    expect(r.json.pageActions).toEqual([{ page: "task", label: "Esegui il task", request: "Esegui il task corrente" }]);
    const [row] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
    expect(row!.pageActions).toHaveLength(1);
  });

  it("azioni non valide → 400 col messaggio fisso; App inesistente → 404", async () => {
    const bad = await put({ actions: [{ page: "a b", label: "x", request: "y" }] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("tipo di pagina non valido");
    const res = await fetch(`${base}/api/apps/999999/page-actions`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions: [] }) });
    expect(res.status).toBe(404);
  });

  it("token agent e api:read → 403", async () => {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
    for (const scopes of [["agent"], ["api:read"]] as const) {
      const { token } = await createApiToken(user!.id, "t", 1, [...scopes]);
      const r = await put({ actions }, { authorization: `Bearer ${token}` });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe(DENIED);
    }
  });
});
