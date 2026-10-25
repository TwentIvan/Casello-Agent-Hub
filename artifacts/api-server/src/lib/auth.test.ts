import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import type { Session, SessionData } from "express-session";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, usersTable } from "@workspace/db";

// Conversione delle sessioni della fase 1 (solo user.email) e requireAuth con login attivo.
// auth.ts legge la configurazione all'import: le variabili si impostano prima dell'import dinamico.

const ENV: Record<string, string> = {
  PUBLIC_APP_URL: "http://casello.test",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: "segreto-sessione",
  ALLOWED_EMAILS: "ivan@example.com",
};
const ENV_KEYS = [...Object.keys(ENV), "AUTH_DISABLED"];
const saved: Record<string, string | undefined> = {};

let auth: typeof import("./auth");
let users: typeof import("./users");

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.AUTH_DISABLED;
  Object.assign(process.env, ENV);
  auth = await import("./auth");
  users = await import("./users");
});

afterAll(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

describe("resolveSessionUserId", () => {
  it("sessione con userId: lo restituisce senza toccare il DB", async () => {
    const session: Partial<SessionData> = { userId: 99 };
    expect(await auth.resolveSessionUserId(session)).toBe(99);
    expect(await db.select().from(usersTable)).toHaveLength(0);
  });

  it("sessione vecchia con solo user.email: trova o crea l'utente e scrive userId", async () => {
    const session: Partial<SessionData> = { user: { email: "Ivan@Example.com", name: "Ivan", picture: null } };
    const id = await auth.resolveSessionUserId(session);
    expect(id).toEqual(expect.any(Number));
    expect(session.userId).toBe(id);
    const [user] = await db.select().from(usersTable);
    expect(user).toMatchObject({ id, email: "ivan@example.com", name: "Ivan" });

    // Una seconda sessione vecchia con la stessa email ritrova lo stesso utente
    const other: Partial<SessionData> = { user: { email: "ivan@example.com", name: null, picture: null } };
    expect(await auth.resolveSessionUserId(other)).toBe(id);
  });

  it("sessione senza utente: null", async () => {
    expect(await auth.resolveSessionUserId({})).toBeNull();
  });
});

describe("requireAuth", () => {
  let server: http.Server;
  let base: string;
  let fakeSession: Partial<SessionData>;

  beforeAll(async () => {
    const app = express();
    // Sessione finta al posto di sessionMiddleware: niente cookie firmati da costruire a mano
    const injectSession: RequestHandler = (req, _res, next) => {
      req.session = fakeSession as Session & Partial<SessionData>;
      next();
    };
    app.get("/protetta", injectSession, auth.requireAuth, (req, res) => {
      res.json({ userId: req.userId, fromHelper: auth.currentUserId(req) });
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sessione vecchia: la richiesta passa, req.userId è impostato e la sessione ottiene userId", async () => {
    fakeSession = { user: { email: "ivan@example.com", name: "Ivan", picture: null } };
    const res = await fetch(`${base}/protetta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: number; fromHelper: number };
    const [user] = await db.select().from(usersTable);
    expect(body).toEqual({ userId: user!.id, fromHelper: user!.id });
    expect(fakeSession.userId).toBe(user!.id);
  });

  it("sessione con userId: passa con quell'id", async () => {
    const user = await users.ensureUserByEmail("ivan@example.com");
    fakeSession = { userId: user.id, user: { email: "ivan@example.com", name: null, picture: null } };
    const res = await fetch(`${base}/protetta`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: user.id, fromHelper: user.id });
  });

  it("senza sessione: 401", async () => {
    fakeSession = {};
    const res = await fetch(`${base}/protetta`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Login richiesto" });
  });
});

describe("safeReturnTo", () => {
  it.each([
    ["/\\evil.com", "/"],
    ["//evil.com", "/"],
    ["/\t/evil.com", "/"],
    ["/\n/evil.com", "/"],
    ["/runs\\x", "/"],
    ["https://evil.com", "/"],
    ["evil.com", "/"],
    ["", "/"],
    ["/runs/3?x=1", "/runs/3?x=1"],
    ["/", "/"],
  ])("%j → %j", (input, expected) => {
    expect(auth.safeReturnTo(input)).toBe(expected);
  });

  it("valori non stringa: /", () => {
    expect(auth.safeReturnTo(undefined)).toBe("/");
    expect(auth.safeReturnTo(["/runs"])).toBe("/");
  });

  it("/%5Cevil.com resta com'è: codificato, si risolve come percorso della nostra origine", () => {
    const result = auth.safeReturnTo("/%5Cevil.com");
    expect(result).toBe("/%5Cevil.com");
    expect(new URL(result, "https://casello.example").origin).toBe("https://casello.example");
  });
});
