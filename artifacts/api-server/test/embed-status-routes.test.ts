import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, usersTable } from "@workspace/db";
import { createApiToken } from "../src/lib/api-tokens";
import { ensureEmbedClients } from "../src/lib/embed/clients";
import { resetPageSeen } from "../src/lib/embed/status";
import { resetEmbedStatusLimits } from "../src/middlewares/rate-limit";

// GET /api/embed/status: solo sessione o token del pannello, App ospite del client, tipi di pagina visti, limite 60/min.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "EMBED_ALLOWED_ORIGINS"];
const saved: Record<string, string | undefined> = {};
const ORIGIN = "https://hubup.fantamister.cloud";
const PUBLIC = "https://casello.example.test";

let base: string;
let server: http.Server;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "a".repeat(64),
    PUBLIC_APP_URL: PUBLIC,
    EMBED_ALLOWED_ORIGINS: ORIGIN,
  });
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients, apps, users RESTART IDENTITY CASCADE");
  await db.insert(usersTable).values({ email: "dev@localhost" });
  await ensureEmbedClients();
  await db.insert(appsTable).values([
    { name: "Botcave", slug: "casello", baseUrl: "http://casello.example" },
    {
      name: "The Hub Up",
      slug: "thu",
      baseUrl: ORIGIN,
      pageActions: [{ page: "task", label: "Esegui", request: "Esegui il task" }],
    },
  ]);
  resetPageSeen();
  resetEmbedStatusLimits();
});

async function embedToken(): Promise<string> {
  const clientId = `embed:${ORIGIN}`;
  const redirectUri = `${PUBLIC}/embed/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "embed",
  }).toString();
  const page = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const dec = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
  });
  const code = new URL(dec.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
  });
  return ((await tok.json()) as { access_token: string }).access_token;
}

const status = (qs: string, token?: string) =>
  fetch(`${base}/api/embed/status?${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({
    status: r.status,
    json: (await r.json()) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  }));

describe("GET /api/embed/status", () => {
  it("token del pannello: stato dell'App ospite e tipo di pagina registrato", async () => {
    const t = await embedToken();
    const r = await status("page=task", t);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      pending: 0,
      bugs: 0,
      actions: [{ label: "Esegui" }],
      leadAvailable: false,
      leadWorking: false,
      botNames: { alfred: "Alfred", lucius: "Lucius", lead: "Responsabile" },
    });
    const [row] = await db.select().from(appsTable).where(eq(appsTable.slug, "thu"));
    expect(row!.embedPagesSeen).toEqual(["task"]);
    expect((await status("app=thu&page=project", t)).status).toBe(200);
  });

  it("token del pannello su un'altra App → 404 «App non trovata»", async () => {
    const t = await embedToken();
    const r = await status("app=casello&page=task", t);
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("App non trovata");
  });

  it("page non valido → 400", async () => {
    const t = await embedToken();
    for (const page of ["due%20parole", "x".repeat(41)]) {
      const r = await status(`page=${page}`, t);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("tipo di pagina non valido");
    }
  });

  it("sessione: App di Botcave senza slug; token personale → 403", async () => {
    const r = await status("page=dashboard");
    expect(r.status).toBe(200);
    expect(r.json.botNames.lead).toBe("Barbara");
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
    const { token } = await createApiToken(user!.id, "t", 1, ["api:read"]);
    expect((await status("page=dashboard", token)).status).toBe(403);
  });

  it("un errore nella scrittura dei tipi di pagina visti non fa fallire lo stato", async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION fail_seen() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'scrittura rifiutata'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER fail_seen_trg BEFORE UPDATE OF embed_pages_seen ON apps FOR EACH ROW EXECUTE FUNCTION fail_seen()`);
    try {
      const t = await embedToken();
      const r = await status("page=task", t);
      expect(r.status).toBe(200);
      const [row] = await db.select().from(appsTable).where(eq(appsTable.slug, "thu"));
      expect(row!.embedPagesSeen).toEqual([]);
    } finally {
      await pool.query("DROP TRIGGER fail_seen_trg ON apps");
    }
    // Il limite di scrittura non si è consumato: ora la scrittura riesce
    const t2 = await embedToken();
    expect((await status("page=task", t2)).status).toBe(200);
    const [row2] = await db.select().from(appsTable).where(eq(appsTable.slug, "thu"));
    expect(row2!.embedPagesSeen).toEqual(["task"]);
  });

  it("il 61° giro in un minuto → 429", async () => {
    for (let i = 0; i < 60; i++) expect((await status("page=task")).status).toBe(200);
    expect((await status("page=task")).status).toBe(429);
  });
});
