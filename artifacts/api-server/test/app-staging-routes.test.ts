import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, usersTable } from "@workspace/db";
import { STAGING_MESSAGES } from "../src/lib/teams/staging";

// Branch e indirizzo di prova dell'App (lavoro su branch unico) con PATCH /apps/:id, sull'app completa con AUTH_DISABLED=true.

const DEV_EMAIL = "dev@localhost";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let appId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { AUTH_DISABLED: "true", ALLOWED_EMAILS: DEV_EMAIL, CASELLO_SECRET_KEY: "a".repeat(64) });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE apps, users CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps, users CASCADE");
  await db.insert(usersTable).values({ email: DEV_EMAIL, name: "Dev" });
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Hub", slug: "hub", baseUrl: "https://hub.example", sourceBranch: "develop" })
    .returning();
  appId = app!.id;
});

describe("PATCH /apps/:id versione di prova", () => {
  it("salva branch e indirizzo di prova, l'App li espone, null li toglie", async () => {
    const r = await api("PATCH", `/apps/${appId}`, { stagingBranch: "staging", stagingUrl: "https://staging.hub.example" });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ stagingBranch: "staging", stagingUrl: "https://staging.hub.example" });
    expect((await api("GET", `/apps/${appId}`)).json.stagingBranch).toBe("staging");
    const cleared = await api("PATCH", `/apps/${appId}`, { stagingBranch: null, stagingUrl: null });
    expect(cleared.json).toMatchObject({ stagingBranch: null, stagingUrl: null });
  });

  it("branch uguale al base dell'App, main o di Botcave: 400 col messaggio fisso", async () => {
    for (const stagingBranch of ["develop", "main", "botcave/x"]) {
      const r = await api("PATCH", `/apps/${appId}`, { stagingBranch });
      expect(r.status, stagingBranch).toBe(400);
      expect(r.json.error).toBe(STAGING_MESSAGES.branch);
    }
  });

  it("indirizzo non https: 400", async () => {
    const r = await api("PATCH", `/apps/${appId}`, { stagingUrl: "http://staging.hub.example" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(STAGING_MESSAGES.url);
  });
});
