import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { createSkill, updateSkill } from "../lib/teams/skills";

// Catalogo delle skill sull'app completa senza login (AUTH_DISABLED=true), più la libreria
// direttamente per le transazioni e la concorrenza.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

const newSkill = (over: Record<string, unknown> = {}) => ({
  code: "sap.abap-review",
  name: "Review ABAP",
  kind: "casello",
  content: "Controlla il codice ABAP.",
  ...over,
});

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE skills, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE skills RESTART IDENTITY CASCADE");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catalogo delle skill", () => {
  it("crea la versione 1 e la rilegge", async () => {
    const created = await api("POST", "/skills", newSkill({ toolHints: ["crea_ordine"] }));
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({
      code: "sap.abap-review",
      name: "Review ABAP",
      description: "",
      kind: "casello",
      currentVersion: 1,
      deprecated: false,
      content: "Controlla il codice ABAP.",
      toolHints: ["crea_ordine"],
    });
    const got = await api("GET", "/skills/sap.abap-review");
    expect(got.status).toBe(200);
    expect(got.json).toEqual(created.json);
  });

  it("rifiuta codici non validi, duplicati e contenuti non validi", async () => {
    expect((await api("POST", "/skills", newSkill({ code: "Sap.X" }))).status).toBe(400);
    expect((await api("POST", "/skills", newSkill({ code: "a" }))).status).toBe(400);
    const node = await api("POST", "/skills", newSkill({ kind: "node", content: "drg sibilla" }));
    expect(node.status).toBe(400);
    expect(node.json.error).toMatch(/nodo/);
    expect((await api("POST", "/skills", newSkill({ content: "   " }))).status).toBe(400);
    expect((await api("POST", "/skills", newSkill({ content: "x".repeat(20_001) }))).status).toBe(400);
    expect((await api("POST", "/skills", newSkill({ kind: "node", content: "drg-sibilla:kt", toolHints: ["x"] }))).status).toBe(400);

    expect((await api("POST", "/skills", newSkill())).status).toBe(201);
    const dup = await api("POST", "/skills", newSkill({ name: "Altro" }));
    expect(dup.status).toBe(409);
    expect(dup.json).toEqual({ error: "codice già usato" });
  });

  it("accetta una skill node con nome valido", async () => {
    const ok = await api("POST", "/skills", newSkill({ code: "kt.sibilla", kind: "node", content: "drg-sibilla:drg-sibilla" }));
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.kind).toBe("node");
  });

  it("PATCH di nome o descrizione non crea versioni; di content sì e la v1 resta", async () => {
    await api("POST", "/skills", newSkill());
    const renamed = await api("PATCH", "/skills/sap.abap-review", { name: "Nuovo nome", description: "descr" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ name: "Nuovo nome", description: "descr", currentVersion: 1 });
    expect((await api("GET", "/skills/sap.abap-review/versions")).json).toHaveLength(1);

    const v2 = await api("PATCH", "/skills/sap.abap-review", { content: "Istruzioni nuove" });
    expect(v2.status, v2.text).toBe(200);
    expect(v2.json).toMatchObject({ currentVersion: 2, content: "Istruzioni nuove" });

    const versions = await api("GET", "/skills/sap.abap-review/versions");
    expect(versions.json.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const v1 = await api("GET", "/skills/sap.abap-review/versions/1");
    expect(v1.status).toBe(200);
    expect(v1.json).toMatchObject({ code: "sap.abap-review", version: 1, content: "Controlla il codice ABAP.", toolHints: [] });

    // solo toolHints: nuova versione che conserva il contenuto
    const v3 = await api("PATCH", "/skills/sap.abap-review", { toolHints: ["a"] });
    expect(v3.json).toMatchObject({ currentVersion: 3, content: "Istruzioni nuove", toolHints: ["a"] });
  });

  it("PATCH con contenuto non valido o skill inesistente", async () => {
    await api("POST", "/skills", newSkill({ kind: "node", code: "kt.n", content: "nome-valido" }));
    expect((await api("PATCH", "/skills/kt.n", { content: "drg sibilla" })).status).toBe(400);
    expect((await api("PATCH", "/skills/kt.n", { toolHints: ["x"] })).status).toBe(400);
    expect((await api("GET", "/skills/kt.n/versions")).json).toHaveLength(1);
    expect((await api("PATCH", "/skills/nessuna", { name: "x" })).status).toBe(404);
  });

  it("la 201ª versione risponde 409", async () => {
    await api("POST", "/skills", newSkill());
    await pool.query("UPDATE skills SET current_version = 200");
    await pool.query("INSERT INTO skill_versions (skill_id, version, content) SELECT id, 200, 'v200' FROM skills");
    const res = await api("PATCH", "/skills/sap.abap-review", { content: "oltre" });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "troppe versioni: crea una skill nuova" });
    // nome/descrizione restano modificabili
    expect((await api("PATCH", "/skills/sap.abap-review", { name: "ok" })).status).toBe(200);
  });

  it("due PATCH concorrenti non assegnano lo stesso numero di versione", async () => {
    await createSkill({ code: "sap.race", name: "Race", kind: "casello", content: "v1" });
    const results = await Promise.allSettled([
      updateSkill("sap.race", { content: "a" }),
      updateSkill("sap.race", { content: "b" }),
      updateSkill("sap.race", { content: "c" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const { rows } = await pool.query("SELECT version FROM skill_versions ORDER BY version");
    expect(rows.map((r: { version: number }) => r.version)).toEqual([1, 2, 3, 4]);
  });

  it("deprecate segna la skill; skill inesistente 404", async () => {
    await api("POST", "/skills", newSkill());
    const dep = await api("POST", "/skills/sap.abap-review/deprecate");
    expect(dep.status).toBe(200);
    expect(dep.json.deprecated).toBe(true);
    expect((await api("POST", "/skills/nessuna/deprecate")).status).toBe(404);
  });

  it("elenco filtrato per kind, q (codice e nome) e deprecated", async () => {
    await api("POST", "/skills", newSkill({ code: "sap.abap-review", name: "Review ABAP" }));
    await api("POST", "/skills", newSkill({ code: "web.seo", name: "Controllo SEO" }));
    await api("POST", "/skills", newSkill({ code: "kt.sibilla", kind: "node", name: "Sibilla", content: "drg-sibilla" }));
    await api("POST", "/skills/web.seo/deprecate");

    const codes = async (qs: string) => (await api("GET", `/skills${qs}`)).json.map((s: { code: string }) => s.code);
    expect(await codes("")).toEqual(["kt.sibilla", "sap.abap-review", "web.seo"]);
    expect(await codes("?kind=node")).toEqual(["kt.sibilla"]);
    expect(await codes("?q=abap")).toEqual(["sap.abap-review"]);
    expect(await codes("?q=SEO")).toEqual(["web.seo"]);
    expect(await codes("?q=web.")).toEqual(["web.seo"]);
    expect(await codes("?q=%25")).toEqual([]);
    expect(await codes("?deprecated=true")).toEqual(["web.seo"]);
    expect(await codes("?deprecated=false")).toEqual(["kt.sibilla", "sap.abap-review"]);
    expect((await api("GET", "/skills?kind=boh")).status).toBe(400);
  });

  it("versione o skill inesistente → 404", async () => {
    await api("POST", "/skills", newSkill());
    expect((await api("GET", "/skills/sap.abap-review/versions/9")).status).toBe(404);
    expect((await api("GET", "/skills/nessuna/versions/1")).status).toBe(404);
    expect((await api("GET", "/skills/nessuna/versions")).status).toBe(404);
    expect((await api("GET", "/skills/nessuna")).status).toBe(404);
    expect((await api("GET", "/skills/sap.abap-review/versions/abc")).status).toBe(400);
  });

  it("createSkill e updateSkill partecipano alla transazione di chi chiama", async () => {
    const { db } = await import("@workspace/db");
    await expect(
      db.transaction(async (tx) => {
        await createSkill({ code: "sap.tx", name: "Tx", kind: "casello", content: "v1" }, tx);
        await updateSkill("sap.tx", { content: "v2" }, tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await api("GET", "/skills/sap.tx")).status).toBe(404);
  });

  it("con un token personale: lettura con api:read, scrittura solo con api:write", async () => {
    await api("POST", "/skills", newSkill());
    const { rows } = await pool.query("INSERT INTO users (email, name) VALUES ('dev@localhost','Dev') ON CONFLICT (email) DO UPDATE SET name='Dev' RETURNING id");
    const userId = rows[0].id as number;
    const read = (await createApiToken(userId, "lettura", 30, ["api:read"])).token;
    const write = (await createApiToken(userId, "scrittura", 30, ["api:write"])).token;
    expect((await api("GET", "/skills", undefined, read)).status).toBe(200);
    expect((await api("POST", "/skills", newSkill({ code: "x.y" }), read)).status).toBe(403);
    expect((await api("POST", "/skills", newSkill({ code: "x.y" }), write)).status).toBe(201);
  });
});
