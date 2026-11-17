import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appsTable, bugReportsTable, db, pool } from "@workspace/db";

vi.mock("../src/lib/bugs/triage", () => ({ startTriage: vi.fn(async () => {}) }));

import { encryptSecret } from "../src/lib/secrets";
import { generateIdentitySecret } from "../src/lib/bugs/identity";
import { resetBugLimits } from "../src/middlewares/rate-limit";

const ORIGIN = "https://hub.example.com";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "EMBED_ALLOWED_ORIGINS"] as const;
const saved: Record<string, string | undefined> = {};
const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(43);

let base: string;
let server: http.Server;
let appId: number;
const SLUG = "hub-bug-routes";
let secret: string;

function jwt(over: Record<string, unknown> = {}, key = secret, now = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: SLUG, aud: "botcave", sub: "u-1", name: "Ana", iat: now, exp: now + 300, ...over });
  return `${head}.${body}.${createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")}`;
}

type Opts = { app?: string | null; origin?: string | null; key?: string | null; identity?: string; body?: unknown; raw?: string; headers?: Record<string, string> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, o: Opts = {}): Promise<{ status: number; json: any }> {
  const q = new URLSearchParams();
  if (o.app !== null) q.set("app", o.app ?? SLUG);
  if (o.origin !== null) q.set("origin", o.origin ?? ORIGIN);
  const headers: Record<string, string> = { "content-type": "application/json", ...o.headers };
  if (o.key !== null) headers["x-botcave-browser-key"] = o.key ?? KEY_A;
  if (o.identity) headers["x-botcave-identity"] = o.identity;
  const res = await fetch(`${base}/api${path}?${q}`, {
    method,
    headers,
    body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : undefined };
}

const bug = { title: "Non salva", description: "Il pulsante non fa nulla" };
const UNAVAILABLE = { error: "segnalazioni non disponibili" };

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    EMBED_ALLOWED_ORIGINS: `${ORIGIN},https://altro.example.com`,
  });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  secret = generateIdentitySecret();
  await db.delete(appsTable).where(eq(appsTable.slug, SLUG));
  const [row] = await db
    .insert(appsTable)
    .values({ name: "Hub bug", slug: SLUG, baseUrl: ORIGIN, bugReportsEnabled: true, identitySecretEnc: encryptSecret(secret) })
    .returning();
  appId = row!.id;
});

beforeEach(async () => {
  await db.delete(bugReportsTable);
  await db.update(appsTable).set({ bugReportsEnabled: true, identitySecretEnc: encryptSecret(secret) }).where(eq(appsTable.id, appId));
  resetBugLimits();
});

afterAll(async () => {
  await db.delete(bugReportsTable);
  await db.delete(appsTable).where(eq(appsTable.slug, SLUG));
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await pool.end();
});

describe("accesso: 404 indistinguibili", () => {
  it("origine non ammessa, diversa dal base_url, App spenta o inesistente", async () => {
    for (const o of [
      { origin: "https://evil.example.com" },
      { origin: "https://altro.example.com" },
      { origin: null },
      { app: "non-esiste" },
      { app: null },
    ]) {
      const r = await call("GET", "/embed/bugs", o);
      expect(r.status).toBe(404);
      expect(r.json).toEqual(UNAVAILABLE);
    }
    await db.update(appsTable).set({ bugReportsEnabled: false }).where(eq(appsTable.id, appId));
    const off = await call("POST", "/embed/bugs", { body: bug });
    expect(off.status).toBe(404);
    expect(off.json).toEqual(UNAVAILABLE);
  });

  it("un header Authorization non cambia nulla", async () => {
    const r = await call("GET", "/embed/bugs", { origin: "https://evil.example.com", headers: { authorization: "Bearer cas_x" } });
    expect(r.status).toBe(404);
    const ok = await call("GET", "/embed/bugs", { headers: { authorization: "Bearer cas_x" } });
    expect(ok.status).toBe(200);
  });
});

describe("segnalazioni", () => {
  it("crea con la chiave del browser, 400 senza chiave o con chiave non valida", async () => {
    const r = await call("POST", "/embed/bugs", { body: bug });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ number: 1, status: "received" });
    const [row] = await db.select().from(bugReportsTable);
    expect(row!.reporterKind).toBe("browser");
    const none = await call("POST", "/embed/bugs", { key: null, body: bug });
    expect(none.status).toBe(400);
    expect(none.json.error).toBe("chiave del browser non valida");
    expect((await call("GET", "/embed/bugs", { key: "corta" })).status).toBe(400);
  });

  it("dettaglio, messaggi e lettura solo per il proprio richiedente", async () => {
    const { json: created } = await call("POST", "/embed/bugs", { body: bug });
    const mine = await call("GET", `/embed/bugs/${created.id}`);
    expect(mine.status).toBe(200);
    expect(mine.json.description).toBe(bug.description);
    expect((await call("GET", `/embed/bugs/${created.id}`, { key: KEY_B })).status).toBe(404);
    expect((await call("GET", "/embed/bugs/abc")).status).toBe(400);
    expect((await call("POST", `/embed/bugs/${created.id}/messages`, { body: { content: "ciao" } })).status).toBe(409);
    expect((await call("POST", `/embed/bugs/${created.id}/messages`, { key: KEY_B, body: { content: "ciao" } })).status).toBe(404);
    const list = await call("GET", "/embed/bugs");
    expect(list.json).toHaveLength(1);
    expect((await call("GET", "/embed/bugs", { key: KEY_B })).json).toHaveLength(0);
    const seen = await call("POST", "/embed/bugs/seen", { body: { ids: [created.id] } });
    expect(seen.json).toEqual({ updated: 1 });
    expect((await call("POST", "/embed/bugs/seen", { key: KEY_B, body: { ids: [created.id] } })).json).toEqual({ updated: 0 });
  });

  it("risponde a una domanda in needs_info", async () => {
    const { json: created } = await call("POST", "/embed/bugs", { body: bug });
    await db.update(bugReportsTable).set({ status: "needs_info" }).where(eq(bugReportsTable.id, created.id));
    const r = await call("POST", `/embed/bugs/${created.id}/messages`, { body: { content: "Succede su Chrome" } });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("triage");
    expect(r.json.messages.at(-1)).toMatchObject({ author: "reporter", content: "Succede su Chrome" });
  });
});

describe("identità", () => {
  it("token valido: stessa persona da un'altra chiave del browser", async () => {
    const t = jwt();
    const r = await call("POST", "/embed/bugs", { body: bug, identity: t });
    expect(r.status).toBe(201);
    const [row] = await db.select().from(bugReportsTable);
    expect(row).toMatchObject({ reporterKind: "identity", reporterSub: "u-1", reporterName: "Ana" });
    const other = await call("GET", "/embed/bugs", { key: KEY_B, identity: t });
    expect(other.json).toHaveLength(1);
    expect((await call("GET", "/embed/bugs", { key: KEY_B })).json).toHaveLength(0);
  });

  it("token di un altro segreto 401, scaduto 401", async () => {
    const wrong = await call("GET", "/embed/bugs", { identity: jwt({}, generateIdentitySecret()) });
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual({ error: "identità non valida" });
    const old = Math.floor(Date.now() / 1000) - 3600;
    const expired = await call("GET", "/embed/bugs", { identity: jwt({}, secret, old) });
    expect(expired.status).toBe(401);
    expect(expired.json).toEqual({ error: "identità scaduta" });
  });

  it("App senza segreto: il token si ignora e vale il browser", async () => {
    await db.update(appsTable).set({ identitySecretEnc: null }).where(eq(appsTable.id, appId));
    const r = await call("POST", "/embed/bugs", { body: bug, identity: "qualunque.cosa.qui" });
    expect(r.status).toBe(201);
    const [row] = await db.select().from(bugReportsTable);
    expect(row!.reporterKind).toBe("browser");
  });
});

describe("limiti", () => {
  it("corpo di 33 KB → 413", async () => {
    const r = await call("POST", "/embed/bugs", { raw: JSON.stringify({ title: "x", description: "y".repeat(33 * 1024) }) });
    expect(r.status).toBe(413);
  });

  it("61ª richiesta al minuto dallo stesso IP → 429", async () => {
    for (let i = 0; i < 60; i++) expect((await call("GET", "/embed/bugs")).status).toBe(200);
    const r = await call("GET", "/embed/bugs");
    expect(r.status).toBe(429);
    expect(r.json).toEqual({ error: "Troppe richieste: riprova tra poco" });
  });

  it("11ª segnalazione nell'ora dallo stesso IP → 429", async () => {
    await db.update(appsTable).set({ bugReportsDailyLimit: 500 }).where(eq(appsTable.id, appId));
    for (let i = 0; i < 10; i++) {
      const key = Buffer.from(`k${i}`.padEnd(32, "x")).toString("base64url");
      expect((await call("POST", "/embed/bugs", { key, body: bug })).status).toBe(201);
    }
    const r = await call("POST", "/embed/bugs", { key: KEY_B, body: bug });
    expect(r.status).toBe(429);
    await db.update(appsTable).set({ bugReportsDailyLimit: 20 }).where(eq(appsTable.id, appId));
  });
});

describe("GET /embed/config", () => {
  it("riporta bugs per l'App, spento senza app o con App disattivata", async () => {
    const get = async (q: string) => (await fetch(`${base}/api/embed/config?${q}`)).json() as Promise<{ bugs: unknown }>;
    expect((await get(`origin=${encodeURIComponent(ORIGIN)}&app=${SLUG}`)).bugs).toEqual({ enabled: true, identity: true });
    expect((await get(`origin=${encodeURIComponent(ORIGIN)}`)).bugs).toEqual({ enabled: false, identity: false });
    await db.update(appsTable).set({ bugReportsEnabled: false }).where(eq(appsTable.id, appId));
    expect((await get(`origin=${encodeURIComponent(ORIGIN)}&app=${SLUG}`)).bugs).toEqual({ enabled: false, identity: false });
    expect((await get(`origin=${encodeURIComponent("https://evil.example.com")}&app=${SLUG}`)).bugs).toEqual({ enabled: false, identity: false });
  });
});
