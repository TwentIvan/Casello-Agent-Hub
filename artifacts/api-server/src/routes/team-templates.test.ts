import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Route dei modelli di squadra sull'app completa senza login (AUTH_DISABLED=true)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let modelId: number;
let userId: number;

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

const role = (over: Record<string, unknown> = {}) => ({
  key: "capo",
  name: "Capo",
  task: "",
  isLead: true,
  runsOn: "cloud",
  aiModelId: modelId,
  tools: [],
  skills: [],
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
  await pool.query("TRUNCATE team_templates, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE team_templates, ai_accounts, users RESTART IDENTITY CASCADE");
  // L'utente di sviluppo è creato dal login disattivato alla prima richiesta
  const me = await api("GET", "/auth/me");
  expect(me.status, me.text).toBe(200);
  const [u] = await db.select().from(usersTable);
  userId = u!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "A", provider: "custom", baseUrl: "https://llm.example.com/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m1", displayName: "M1" }).returning();
  modelId = model!.id;
});

describe("route dei modelli di squadra", () => {
  it("crea, legge, salva, legge la versione e cancella", async () => {
    const created = await api("POST", "/team-templates", { name: "Sviluppo", roles: [role()] });
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ version: 1, instanceCount: 0, roles: [{ key: "capo", model: { name: "M1" } }] });
    const id = created.json.id;

    const saved2 = await api("PUT", `/team-templates/${id}`, { name: "Sviluppo", roles: [role({ task: "v2" })] });
    expect(saved2.status, saved2.text).toBe(200);
    expect(saved2.json.version).toBe(2);

    const v1 = await api("GET", `/team-templates/${id}/versions/1`);
    expect(v1.status, v1.text).toBe(200);
    expect(v1.json[0].task).toBe("");
    expect((await api("GET", `/team-templates/${id}/versions/9`)).status).toBe(404);

    const list = await api("GET", "/team-templates");
    expect(list.json.map((t: { id: number }) => t.id)).toEqual([id]);
    expect((await api("GET", "/team-templates?archived=true")).json).toEqual([]);

    expect((await api("DELETE", `/team-templates/${id}`)).json).toEqual({ deleted: true, archived: false });
    expect((await api("GET", `/team-templates/${id}`)).status).toBe(404);
  });

  it("errori: regola violata 400, nome doppio 409, corpo non valido 400", async () => {
    const bad = await api("POST", "/team-templates", { name: "X", roles: [role({ isLead: false })] });
    expect(bad).toMatchObject({ status: 400 });
    expect(bad.json.error).toBe("una squadra ha esattamente un capo");
    expect((await api("POST", "/team-templates", { name: "", roles: [] })).status).toBe(400);
    expect((await api("POST", "/team-templates", { name: "Doppio", roles: [role()] })).status).toBe(201);
    const dup = await api("POST", "/team-templates", { name: "Doppio", roles: [role()] });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("nome già usato");
    expect((await api("PUT", "/team-templates/9999", { name: "Z", roles: [role()] })).status).toBe(404);
  });

  it("con un token: GET con api:read, scrittura solo con api:write", async () => {
    const rt = (await createApiToken(userId, "lettura", 30, ["api:read"])).token;
    const wt = (await createApiToken(userId, "scrittura", 30, ["api:write"])).token;
    expect((await api("GET", "/team-templates", undefined, rt)).status).toBe(200);
    expect((await api("POST", "/team-templates", { name: "T", roles: [role()] }, rt)).status).toBe(403);
    expect((await api("POST", "/team-templates", { name: "T", roles: [role()] }, wt)).status).toBe(201);
  });
});
