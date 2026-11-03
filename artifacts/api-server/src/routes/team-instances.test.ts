import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";

// Route delle squadre (istanze) sull'app completa senza login (AUTH_DISABLED=true)

process.env["CASELLO_SECRET_KEY"] ??= "e".repeat(64);
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let modelId: number;
let userId: number;
let appId: number;

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
  localSkills: [],
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
  await pool.query("TRUNCATE team_templates, team_instances, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE team_templates, team_instances, apps, ai_accounts, users RESTART IDENTITY CASCADE");
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
  const [app] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "hub-up", baseUrl: "https://a.example.com" }).returning();
  appId = app!.id;
});

describe("route delle squadre", () => {
  it("crea da zero, cerca, salva, chiude e rifiuta il salvataggio dopo la chiusura", async () => {
    const created = await api("POST", "/team-instances", { name: "Squadra", ref: { appId, type: "wi", id: "1174" }, roles: [role()] });
    expect(created.status, created.text).toBe(201);
    expect(created.json).toMatchObject({ status: "draft", template: null, ref: { appName: "The Hub Up", id: "1174" } });
    const id = created.json.id;

    const found = await api("GET", `/team-instances?appId=${appId}&refType=wi&refId=1174`);
    expect(found.json.map((i: { id: number }) => i.id)).toEqual([id]);

    const put = await api("PUT", `/team-instances/${id}`, {
      name: "Squadra 2",
      status: "active",
      roles: [role({ localSkills: ["spec.uno"] })],
      localSkills: [{ code: "spec.uno", name: "Uno", kind: "casello", content: "ok" }],
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({ name: "Squadra 2", status: "active", localSkills: [{ code: "spec.uno" }] });

    expect((await api("GET", `/team-instances/${id}`)).status).toBe(200);
    expect((await api("POST", `/team-instances/${id}/close`)).json.status).toBe("closed");
    const after = await api("PUT", `/team-instances/${id}`, { name: "X", roles: [role()], localSkills: [] });
    expect(after.status).toBe(409);
    expect(after.json.error).toBe("squadra chiusa");
    expect((await api("PUT", `/team-instances/${id}`, { name: "X", status: "closed", roles: [role()], localSkills: [] })).status).toBe(400);
  });

  it("errori: app inesistente 400, modello archiviato 409, non trovata 404, corpo non valido 400", async () => {
    const bad = await api("POST", "/team-instances", { name: "S", ref: { appId: 9999, type: "wi", id: "1" }, roles: [role()] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("app di riferimento inesistente");
    expect((await api("POST", "/team-instances", { name: "S", ref: { appId, type: "NO!", id: "1" }, roles: [role()] })).status).toBe(400);
    expect((await api("POST", "/team-instances", { name: "S", templateId: 9999, ref: { appId, type: "wi", id: "1" } })).status).toBe(404);
    expect((await api("GET", "/team-instances/9999")).status).toBe(404);
    expect((await api("POST", "/team-instances/9999/close")).status).toBe(404);
  });

  it("da modello: archiviato dopo la copia → 409", async () => {
    const t = await api("POST", "/team-templates", {
      name: "Mod",
      roles: [{ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [] }],
    });
    expect(t.status, t.text).toBe(201);
    const inst = await api("POST", "/team-instances", { name: "S", templateId: t.json.id, ref: { appId, type: "wi", id: "1" } });
    expect(inst.status, inst.text).toBe(201);
    expect(inst.json.template).toMatchObject({ name: "Mod", version: 1 });
    await api("DELETE", `/team-templates/${t.json.id}`);
    const again = await api("POST", "/team-instances", { name: "S2", templateId: t.json.id, ref: { appId, type: "wi", id: "1" } });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("modello archiviato");
  });

  it("aggiornamenti: elenco, applicazione, id ripetuti 400, voce non valida 409, chiusa 409", async () => {
    const r = { key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: modelId, tools: [], skills: [] };
    const t = await api("POST", "/team-templates", { name: "Mod", roles: [r] });
    const inst = await api("POST", "/team-instances", { name: "S", templateId: t.json.id, ref: { appId, type: "wi", id: "1" } });
    expect((await api("GET", `/team-instances/${inst.json.id}/updates`)).json).toEqual({ items: [] });
    await api("PUT", `/team-templates/${t.json.id}`, { name: "Mod", roles: [{ ...r, task: "Nuovo" }] });
    const list = await api("GET", `/team-instances/${inst.json.id}/updates`);
    expect(list.status, list.text).toBe(200);
    expect(list.json.items).toEqual([
      { id: "role_changed:capo:task", type: "role_changed", roleKey: "capo", roleName: "Capo", field: "task", from: "", to: "Nuovo" },
    ]);
    const path = `/team-instances/${inst.json.id}/updates/apply`;
    expect((await api("POST", path, { ids: ["role_changed:capo:task", "role_changed:capo:task"] })).status).toBe(400);
    expect((await api("POST", path, { ids: [] })).status).toBe(400);
    const stale = await api("POST", path, { ids: ["role_changed:capo:name"] });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("aggiornamenti cambiati: ricarica");
    const applied = await api("POST", path, { ids: ["role_changed:capo:task"] });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.json).toMatchObject({ template: { version: 2 }, roles: [{ task: "Nuovo" }] });
    await api("POST", `/team-instances/${inst.json.id}/close`);
    const closed = await api("GET", `/team-instances/${inst.json.id}/updates`);
    expect(closed.status).toBe(409);
    expect(closed.json.error).toBe("squadra chiusa");
  });

  it("con un token: GET con api:read, scrittura solo con api:write", async () => {
    const rt = (await createApiToken(userId, "lettura", 30, ["api:read"])).token;
    const wt = (await createApiToken(userId, "scrittura", 30, ["api:write"])).token;
    const body = { name: "S", ref: { appId, type: "wi", id: "1" }, roles: [role()] };
    expect((await api("GET", "/team-instances", undefined, rt)).status).toBe(200);
    expect((await api("POST", "/team-instances", body, rt)).status).toBe(403);
    expect((await api("POST", "/team-instances", body, wt)).status).toBe(201);
  });
});
