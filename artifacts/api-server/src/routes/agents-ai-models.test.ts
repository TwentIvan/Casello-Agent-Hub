import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool, agentsTable, aiAccountsTable, aiModelsTable, analysesTable, usersTable } from "@workspace/db";
import { allowTestLoopback, FAKE_PROVIDER_ERROR_TEXT, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { encryptSecret } from "../lib/secrets";

// Scelta del modello negli agenti e nell'avvio delle analisi (account AI), sull'app completa senza
// login (AUTH_DISABLED=true: l'utente corrente è dev@localhost). Il secondo utente e gli account si
// inseriscono a mano nel DB. File a parte: il rate limit degli avvii (10/minuto) è per file.

const KEY = "sk-CHIAVE-DELL-UTENTE-DEV-11";
const OTHER_KEY = "sk-CHIAVE-DELL-ALTRO-UTENTE-22";
const GATEWAY_KEY = "sk-gateway-di-sistema-33";

let base: string;
let server: http.Server;
let fake: FakeProvider;
let ensureSystemAccount: () => Promise<{ accountId: number } | null>;
let bodies: string[] = [];

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", "AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

/** Account `custom` verso il finto provider, con un modello prezzato. */
async function accountFor(userId: number, key: string, modelId = "fake-model") {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: `Account ${userId}`,
      provider: "custom",
      baseUrl: fake.baseUrl,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret(key),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId, displayName: modelId, priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  return { account: account!, model: model! };
}

async function otherUser() {
  const [user] = await db.insert(usersTable).values({ email: "altro@example.com", name: "Altro" }).returning();
  return user!;
}

async function createApp() {
  const res = await api("POST", "/apps", { name: `App ${Math.random().toString(36).slice(2, 8)}`, baseUrl: fake.baseUrl.replace(/\/v1$/, "") });
  expect(res.status, res.text).toBe(201);
  return res.json as { id: number };
}

async function systemModelId(modelId: string): Promise<number> {
  const [row] = await db
    .select({ id: aiModelsTable.id })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(and(isNull(aiAccountsTable.userId), eq(aiModelsTable.modelId, modelId)));
  return row!.id;
}

/** Attende che nessuna analisi resti queued/running (il finto provider risponde 400). */
async function settleAnalyses() {
  for (let i = 0; i < 500; i++) {
    const active = await db
      .select({ id: analysesTable.id })
      .from(analysesTable)
      .where(inArray(analysesTable.status, ["queued", "running"]));
    if (!active.length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("analisi ancora attive dopo il test");
}

async function loadAnalysis(id: number) {
  const [a] = await db.select().from(analysesTable).where(eq(analysesTable.id, id));
  return a!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  ({ ensureSystemAccount } = await import("../lib/ai/system-account"));
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  bodies = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  // Le chiamate di chat falliscono subito (400): le analisi avviate si chiudono da sole
  fake = await startFakeProvider({ statusFor: { chat: 400 } });
  process.env["AI_GATEWAY_BASE_URL"] = fake.baseUrl;
  process.env["AI_GATEWAY_API_KEY"] = GATEWAY_KEY;
});

afterEach(async () => {
  await settleAnalyses();
  vi.restoreAllMocks();
  await fake.close();
  const rows = await db.select({ error: analysesTable.error }).from(analysesTable);
  for (const text of [...bodies, ...rows.map((r) => r.error ?? "")]) {
    for (const secret of [KEY, OTHER_KEY, GATEWAY_KEY, FAKE_PROVIDER_ERROR_TEXT]) expect(text).not.toContain(secret);
  }
});

// Il finto provider ascolta su 127.0.0.1: deroga dei test al divieto del loopback (vedi allowTestLoopback)
let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

describe("agenti con aiModelId", () => {
  it("creazione con un modello proprio: salvato con il modelId come testo", async () => {
    const dev = await devUserId();
    const { model } = await accountFor(dev, KEY, "modello-dev");
    const app = await createApp();

    const res = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId: model.id, model: "ignorato" });
    expect(res.status, res.text).toBe(201);
    expect(res.json.aiModelId).toBe(model.id);
    expect(res.json.model).toBe("modello-dev");
  });

  it("creazione con il modello di un altro utente → 400 'modello non disponibile', nulla salvato", async () => {
    const other = await otherUser();
    const { model } = await accountFor(other.id, OTHER_KEY);
    const app = await createApp();
    const before = await db.select().from(agentsTable);

    const res = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId: model.id });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "modello non disponibile" });
    expect(await db.select().from(agentsTable)).toHaveLength(before.length);
  });

  it("modello inesistente → 400", async () => {
    const app = await createApp();
    const res = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId: 999_999 });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "modello non disponibile" });
  });

  it("modello dell'account di sistema: ammesso; senza variabili del gateway → 400 col messaggio di sistema", async () => {
    await ensureSystemAccount();
    const sys = await systemModelId("openrouter/auto");
    const app = await createApp();

    const ok = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId: sys });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.aiModelId).toBe(sys);

    delete process.env["AI_GATEWAY_API_KEY"];
    const ko = await api("POST", "/agents", { appId: app.id, name: "Area 2", aiModelId: sys });
    expect(ko.status).toBe(400);
    expect(ko.json).toEqual({ error: "account di sistema non più disponibile" });
  });

  it("PATCH verso il modello di un altro utente → 400 e agente invariato; verso un modello proprio → 200", async () => {
    const dev = await devUserId();
    const mine = await accountFor(dev, KEY, "mio");
    const other = await otherUser();
    const theirs = await accountFor(other.id, OTHER_KEY, "suo");
    const app = await createApp();
    const created = await api("POST", "/agents", { appId: app.id, name: "Area" });
    expect(created.status).toBe(201);

    const ko = await api("PATCH", `/agents/${created.json.id}`, { name: "Nuovo", aiModelId: theirs.model.id });
    expect(ko.status).toBe(400);
    expect(ko.json).toEqual({ error: "modello non disponibile" });
    const [unchanged] = await db.select().from(agentsTable).where(eq(agentsTable.id, created.json.id));
    expect(unchanged!.name).toBe("Area");
    expect(unchanged!.aiModelId).toBeNull();

    const ok = await api("PATCH", `/agents/${created.json.id}`, { aiModelId: mine.model.id });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.aiModelId).toBe(mine.model.id);
    expect(ok.json.model).toBe("mio");
  });

  it("PATCH con il solo model (testo): ignorato; aiModelId null toglie il modello", async () => {
    const dev = await devUserId();
    const mine = await accountFor(dev, KEY, "mio");
    const app = await createApp();
    const created = await api("POST", "/agents", { appId: app.id, name: "Area", aiModelId: mine.model.id });
    expect(created.status, created.text).toBe(201);

    const byName = await api("PATCH", `/agents/${created.json.id}`, { model: "openrouter/auto" });
    expect(byName.status, byName.text).toBe(200);
    expect(byName.json.aiModelId).toBe(mine.model.id);
    expect(byName.json.model).toBe("mio");

    const cleared = await api("PATCH", `/agents/${created.json.id}`, { aiModelId: null });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.json.aiModelId).toBeNull();
    expect(cleared.json.model).toBe("");
  });

  it("un altro utente modifica il nome di un agente con il modello di A → 200, aiModelId invariato (Review Focus 1)", async () => {
    // A = altro utente, proprietario del modello; l'utente corrente (dev) è B
    const a = await otherUser();
    const theirs = await accountFor(a.id, OTHER_KEY, "di-a");
    const app = await createApp();
    const [agent] = await db
      .insert(agentsTable)
      .values({ appId: app.id, name: "Area di A", role: "area", model: "di-a", aiModelId: theirs.model.id })
      .returning();

    const rename = await api("PATCH", `/agents/${agent!.id}`, { name: "Rinominato" });
    expect(rename.status, rename.text).toBe(200);
    expect(rename.json.aiModelId).toBe(theirs.model.id);
    expect(rename.json.name).toBe("Rinominato");

    // La console rimanda lo stesso aiModelId e lo stesso model: nessun controllo, nulla cambia
    const same = await api("PATCH", `/agents/${agent!.id}`, { name: "Ancora", aiModelId: theirs.model.id, model: "di-a" });
    expect(same.status, same.text).toBe(200);
    expect(same.json.aiModelId).toBe(theirs.model.id);
    expect(same.json.model).toBe("di-a");
  });

  it("l'agente generale di una nuova app non usa il modello di sistema: senza predefinito nasce senza modello", async () => {
    await ensureSystemAccount();
    const app = await createApp();
    const [general] = await db.select().from(agentsTable).where(and(eq(agentsTable.appId, app.id), eq(agentsTable.role, "general")));
    expect(general!.aiModelId).toBeNull();
    expect(general!.model).toBe("");
  });

  it("senza account di sistema (o senza le sue variabili) l'agente generale resta senza modello", async () => {
    let app = await createApp();
    let [general] = await db.select().from(agentsTable).where(and(eq(agentsTable.appId, app.id), eq(agentsTable.role, "general")));
    expect(general!.aiModelId).toBeNull();

    // L'account esiste ma non è configurato: niente collegamenti nuovi (il nome in `model` è ignorato)
    await ensureSystemAccount();
    delete process.env["AI_GATEWAY_API_KEY"];
    app = await createApp();
    [general] = await db.select().from(agentsTable).where(and(eq(agentsTable.appId, app.id), eq(agentsTable.role, "general")));
    expect(general!.aiModelId).toBeNull();
    const byName = await api("POST", "/agents", { appId: app.id, name: "Area", model: "openrouter/auto" });
    expect(byName.status, byName.text).toBe(201);
    expect(byName.json.aiModelId).toBeNull();
  });

  it("GET /agents espone aiModelId", async () => {
    const app = await createApp();
    const res = await api("GET", `/agents?appId=${app.id}`);
    expect(res.status).toBe(200);
    expect(res.json[0]).toHaveProperty("aiModelId", null);
  });
});

describe("avvio delle analisi con aiModelId", () => {
  it("modello proprio: analisi con aiModelId e model, la chiamata usa la chiave dell'account; 400 del provider → 'rifiutata'", async () => {
    const dev = await devUserId();
    const { model } = await accountFor(dev, KEY, "modello-dev");
    const app = await createApp();

    const res = await api("POST", `/apps/${app.id}/analyses`, { aiModelId: model.id });
    expect(res.status, res.text).toBe(202);
    expect(res.json.aiModelId).toBe(model.id);
    expect(res.json.model).toBe("modello-dev");
    expect(res.json).toHaveProperty("costUsd", null);

    await settleAnalyses();
    const a = await loadAnalysis(res.json.id);
    expect(a.status).toBe("failed");
    expect(a.error).toContain("richiesta rifiutata dal provider (HTTP 400)");
    const chats = fake.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(chats.length).toBeGreaterThan(0);
    expect(chats.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it("modello di un altro utente → 400 e nessuna analisi; anche via zip", async () => {
    const other = await otherUser();
    const { model } = await accountFor(other.id, OTHER_KEY);
    const app = await createApp();

    const res = await api("POST", `/apps/${app.id}/analyses`, { aiModelId: model.id });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "modello non disponibile" });

    const zip = await fetch(`${base}/api/apps/${app.id}/analyses/zip?aiModelId=${model.id}`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array([1, 2, 3]),
    });
    const text = await zip.text();
    bodies.push(text);
    expect(zip.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "modello non disponibile" });
    expect(await db.select().from(analysesTable)).toHaveLength(0);
  });

  it("senza aiModelId → 400 'scegli un modello', anche via zip e con il solo model (non più accettato)", async () => {
    const app = await createApp();

    const none = await api("POST", `/apps/${app.id}/analyses`, {});
    expect(none.status).toBe(400);
    expect(none.json).toEqual({ error: "scegli un modello" });
    const byName = await api("POST", `/apps/${app.id}/analyses`, { model: "openrouter/auto" });
    expect(byName.status).toBe(400);
    expect(byName.json).toEqual({ error: "scegli un modello" });

    const zip = await fetch(`${base}/api/apps/${app.id}/analyses/zip?model=openrouter%2Fauto`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: new Uint8Array([1, 2, 3]),
    });
    const text = await zip.text();
    bodies.push(text);
    expect(zip.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "scegli un modello" });
    expect(await db.select().from(analysesTable)).toHaveLength(0);
  });

  it("aiModelId con model: il nome è ignorato, conta il modello scelto", async () => {
    const dev = await devUserId();
    const { model } = await accountFor(dev, KEY, "modello-dev");
    const app = await createApp();

    const res = await api("POST", `/apps/${app.id}/analyses`, { aiModelId: model.id, model: "openrouter/auto" });
    expect(res.status, res.text).toBe(202);
    expect(res.json.aiModelId).toBe(model.id);
    expect(res.json.model).toBe("modello-dev");
    await settleAnalyses();
  });
});
