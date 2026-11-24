import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { persistentWindowCounter, runRateLimit, runTriggerRateLimit } from "./rate-limit";

let userA: number;
let userB: number;

beforeAll(async () => {
  const r = await pool.query<{ id: number }>(
    "INSERT INTO users (email) VALUES ('rl-a@example.com'), ('rl-b@example.com') RETURNING id",
  );
  userA = r.rows[0]!.id;
  userB = r.rows[1]!.id;
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE email IN ('rl-a@example.com', 'rl-b@example.com')");
});

beforeEach(async () => {
  await pool.query("DELETE FROM rate_limit_counters");
});

describe("contatore persistente a finestra fissa", () => {
  it("conta per utente nel DB e sopravvive a un nuovo processo (contatore ricreato)", async () => {
    const counter = persistentWindowCounter({ name: "prova", limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) expect((await counter.consume(userA)).ok).toBe(true);
    const over = await counter.consume(userA);
    expect(over.ok).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(over.retryAfterSec).toBeLessThanOrEqual(60);
    // Un altro utente ha il suo contatore
    expect((await counter.consume(userB)).ok).toBe(true);
    // «Riavvio»: un contatore nuovo con lo stesso nome legge le stesse righe
    const restarted = persistentWindowCounter({ name: "prova", limit: 3, windowMs: 60_000 });
    expect((await restarted.consume(userA)).ok).toBe(false);
    const rows = await pool.query<{ bucket: string; count: number }>(
      "SELECT bucket, count FROM rate_limit_counters WHERE user_id = $1",
      [userA],
    );
    expect(rows.rows).toEqual([{ bucket: "prova", count: 5 }]);
  });

  it("i sotto-contatori (es. id del token) sono separati", async () => {
    const counter = persistentWindowCounter({ name: "prova", limit: 1, windowMs: 60_000 });
    expect((await counter.consume(userA, "1")).ok).toBe(true);
    expect((await counter.consume(userA, "1")).ok).toBe(false);
    expect((await counter.consume(userA, "2")).ok).toBe(true);
  });

  it("utente inesistente: ricade sul contatore in memoria, senza spegnere il limite", async () => {
    const counter = persistentWindowCounter({ name: "prova", limit: 2, windowMs: 60_000 });
    expect((await counter.consume(99_999_999)).ok).toBe(true);
    expect((await counter.consume(99_999_999)).ok).toBe(true);
    expect((await counter.consume(99_999_999)).ok).toBe(false);
  });
});

describe("limite dell'avvio di run e analisi", () => {
  let base: string;
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    // Finta autenticazione: utente e token dagli header
    app.use((req, _res, next) => {
      const user = req.header("x-user");
      if (user) req.userId = Number(user);
      const token = req.header("x-token");
      if (token) req.auth = { kind: "token", tokenId: Number(token), scopes: ["runs"] } as typeof req.auth;
      next();
    });
    app.post("/runs", runTriggerRateLimit, (_req, res) => {
      res.status(202).end();
    });
    app.post("/analyses", runRateLimit, (_req, res) => {
      res.status(202).end();
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const post = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers });

  it("10 al minuto per utente, condivisi tra run e analisi; un altro utente non è toccato", async () => {
    const h = { "x-user": String(userA) };
    for (let i = 0; i < 5; i++) expect((await post("/runs", h)).status).toBe(202);
    for (let i = 0; i < 5; i++) expect((await post("/analyses", h)).status).toBe(202);
    const blocked = await post("/runs", h);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await blocked.json()).toEqual({ error: "Troppe richieste: riprova tra poco" });
    expect((await post("/runs", { "x-user": String(userB) })).status).toBe(202);
  });

  it("con un token personale 60 al minuto per token, separati dal limite della sessione", async () => {
    const h = { "x-user": String(userA), "x-token": "7" };
    for (let i = 0; i < 60; i++) expect((await post("/runs", h)).status).toBe(202);
    expect((await post("/runs", h)).status).toBe(429);
    // Un altro token dello stesso utente ha il suo contatore; la sessione pure
    expect((await post("/runs", { ...h, "x-token": "8" })).status).toBe(202);
    expect((await post("/runs", { "x-user": String(userA) })).status).toBe(202);
  });
});
