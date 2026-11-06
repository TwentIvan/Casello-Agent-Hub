import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, usersTable } from "@workspace/db";
import { addHistory } from "../lib/memory/history";

// Route delle memorie dei personaggi (appunti e storico) senza login (AUTH_DISABLED=true)

const ENV_KEYS = ["AUTH_DISABLED"] as const;
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let userId: number;
let otherId: number;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

const entry = (uid: number, character: "alfred" | "lucius", refId: number, title: string, summary = "riassunto") => ({
  userId: uid,
  character,
  kind: "team_chat" as const,
  refId,
  title,
  summary,
  aiModelId: null,
  tokensUsed: 0,
  costUsd: null,
});

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "dev@localhost" }).returning();
  userId = u!.id;
  const [o] = await db.insert(usersTable).values({ email: "altro@x.it" }).returning();
  otherId = o!.id;
});

describe("appunti", () => {
  it("crea (201), elenca, modifica, elimina; separati per personaggio", async () => {
    const created = await api("POST", "/memories/notes", { character: "lucius", content: "  preferisce le tabelle " });
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ content: "preferisce le tabelle", ref: null });
    await api("POST", "/memories/notes", { character: "alfred", content: "dà del tu" });
    expect((await api("GET", "/memories/notes?character=lucius")).json.map((n: { content: string }) => n.content)).toEqual(["preferisce le tabelle"]);
    expect((await api("GET", "/memories/notes?character=alfred")).json).toHaveLength(1);
    const upd = await api("PATCH", `/memories/notes/${created.json.id}?character=lucius`, { content: "nuovo" });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.json.content).toBe("nuovo");
    // personaggio sbagliato: 404, l'appunto resta
    expect((await api("PATCH", `/memories/notes/${created.json.id}?character=alfred`, { content: "x" })).status).toBe(404);
    expect((await api("DELETE", `/memories/notes/${created.json.id}?character=alfred`)).status).toBe(404);
    expect((await api("DELETE", `/memories/notes/${created.json.id}?character=lucius`)).status).toBe(204);
    expect((await api("DELETE", `/memories/notes/${created.json.id}?character=lucius`)).status).toBe(404);
  });

  it("personaggio non valido o mancante → 400", async () => {
    expect((await api("GET", "/memories/notes?character=batman")).status).toBe(400);
    expect((await api("GET", "/memories/notes")).status).toBe(400);
    expect((await api("POST", "/memories/notes", { character: "batman", content: "x" })).status).toBe(400);
    expect((await api("PATCH", "/memories/notes/1", { content: "x" })).status).toBe(400);
    expect((await api("GET", "/memories/history?character=zzz")).status).toBe(400);
  });

  it("vuoto, troppo lungo, credenziale → 400 col messaggio; memoria piena → 409", async () => {
    expect((await api("POST", "/memories/notes", { character: "lucius", content: "   " })).json.error).toBe("appunto vuoto");
    const long = await api("POST", "/memories/notes", { character: "lucius", content: "a".repeat(301) });
    expect(long.status).toBe(400);
    expect(long.json.error).toBe("appunto troppo lungo: al massimo 300 caratteri");
    for (let i = 0; i < 50; i++) expect((await api("POST", "/memories/notes", { character: "lucius", content: `n${i}` })).status).toBe(201);
    const full = await api("POST", "/memories/notes", { character: "lucius", content: "uno di troppo" });
    expect(full.status).toBe(409);
    expect(full.json.error).toBe("memoria piena: unisci o togli un appunto");
  });

  it("gli appunti di un altro utente non si vedono né si toccano", async () => {
    const { addNote } = await import("../lib/memory/notes");
    const theirs = await addNote(otherId, "lucius", "segreto");
    expect((await api("GET", "/memories/notes?character=lucius")).json).toEqual([]);
    expect((await api("PATCH", `/memories/notes/${theirs.id}?character=lucius`, { content: "x" })).status).toBe(404);
    expect((await api("DELETE", `/memories/notes/${theirs.id}?character=lucius`)).status).toBe(404);
  });
});

describe("storico", () => {
  it("elenca e cerca per personaggio e utente; elimina", async () => {
    await addHistory(entry(userId, "lucius", 1, "Ruolo dev", "ho sistemato l'identità"));
    await addHistory(entry(userId, "lucius", 2, "Altro tema", "budget"));
    await addHistory(entry(userId, "alfred", 3, "Di Alfred"));
    await addHistory(entry(otherId, "lucius", 4, "Di un altro"));
    const all = await api("GET", "/memories/history?character=lucius");
    expect(all.status).toBe(200);
    expect(all.json.map((h: { title: string }) => h.title)).toEqual(["Altro tema", "Ruolo dev"]);
    expect(all.json[0]).toMatchObject({ kind: "team_chat", refId: 2 });
    const found = await api("GET", "/memories/history?character=lucius&q=identit%C3%A0");
    expect(found.json.map((h: { title: string }) => h.title)).toEqual(["Ruolo dev"]);
    const id = all.json[0].id;
    expect((await api("DELETE", `/memories/history/${id}?character=alfred`)).status).toBe(404);
    expect((await api("DELETE", `/memories/history/${id}?character=lucius`)).status).toBe(204);
    expect((await api("DELETE", `/memories/history/${id}?character=lucius`)).status).toBe(404);
    expect((await api("GET", "/memories/history?character=alfred")).json).toHaveLength(1);
  });
});
