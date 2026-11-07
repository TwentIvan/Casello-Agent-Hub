import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  agentTriggersTable,
  appToolsTable,
  runsTable,
  triggerSeenItemsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { TRIGGER_MESSAGES } from "../lib/triggers/messages";
import { allowTestLoopback } from "../../test/fake-provider";
import type { TokenScope } from "../lib/api-tokens";

// API degli inneschi (spec §7) sull'app completa (porta 0) con AUTH_DISABLED=true: senza header la richiesta
// passa come sessione dell'utente di sviluppo, con un token personale conta solo il token. La finta app HTTP
// risponde all'elenco letto da «Prova». Lo scheduler delle run e la sorveglianza non partono.
// Le tabelle si svuotano SENZA ripartire con gli id: i limiti in memoria (prova 6/min) sono per id d'utente.

const TOKEN_EMAIL = "inneschi-token@example.com";
const PUBLIC_URL = "https://botcave.example";
const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL"] as const;
const saved: Record<string, string | undefined> = {};

let base: string;
let server: http.Server;
let appServer: http.Server;
let appBase: string;
let appBody: unknown;
let restoreLoopback: () => void;
let createApiToken: typeof import("../lib/api-tokens").createApiToken;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: TOKEN_EMAIL,
    CASELLO_SECRET_KEY: "e".repeat(64),
    PUBLIC_APP_URL: PUBLIC_URL,
  });
  restoreLoopback = allowTestLoopback();
  const { default: app } = await import("../app");
  ({ createApiToken } = await import("../lib/api-tokens"));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  appServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(appBody));
  });
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  appServer.closeAllConnections();
  await new Promise<void>((r) => appServer.close(() => r()));
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  restoreLoopback();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  appBody = { data: { items: [{ id: 1, subject: "Prima" }, { id: 2, subject: "x".repeat(500) }] } };
  await pool.query("TRUNCATE apps, ai_accounts, users CASCADE");
});

afterEach(() => {
  process.env["ALLOWED_EMAILS"] = TOKEN_EMAIL;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

type Seed = { tool?: Partial<typeof appToolsTable.$inferInsert> };

/** App con autenticazione di servizio verso la finta app, agente attivo con modello, tool L0 di servizio. */
async function seed(opts: Seed = {}) {
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, TOKEN_EMAIL));
  const [owner] = existing ? [existing] : await db.insert(usersTable).values({ email: TOKEN_EMAIL, name: "Token" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: owner!.id, name: "Conto", provider: "custom", baseUrl: "https://provider.invalid/v1", apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "m" }).returning();
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: `mister-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "http://mister.example",
      internalBaseUrl: appBase,
      serviceAuth: { header: "X-Api-Key", scheme: null },
      serviceSecretEnc: encryptSecret("segreto-di-servizio"),
    })
    .returning();
  const [agent] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Smistatore", role: "area", status: "active", model: "m", aiModelId: model!.id })
    .returning();
  const [tool] = await db
    .insert(appToolsTable)
    .values({
      appId: app!.id,
      name: "elenco_email",
      description: "Email arrivate",
      kind: "http",
      identity: "service",
      level: "L0",
      status: "active",
      definition: { method: "GET", path: "/emails", paramLocations: { box: "query", since: "query" } },
      paramsSchema: {
        type: "object",
        properties: { box: { type: "string" }, since: { type: "string" } },
        additionalProperties: false,
      },
      ...opts.tool,
    })
    .returning();
  return { ownerId: owner!.id, appId: app!.id, agentId: agent!.id, toolId: tool!.id };
}

const pollInput = (toolId: number, extra: Record<string, unknown> = {}) => ({
  kind: "poll",
  name: "Email",
  toolId,
  args: { box: "in" },
  itemsPath: "data.items",
  idField: "id",
  ...extra,
});

async function tokenWith(userId: number, scopes: TokenScope[]): Promise<string> {
  return (await createApiToken(userId, "Script", 30, scopes)).token;
}

async function seenKeys(triggerId: number): Promise<string[]> {
  const rows = await db
    .select({ k: triggerSeenItemsTable.itemKey })
    .from(triggerSeenItemsTable)
    .where(eq(triggerSeenItemsTable.triggerId, triggerId))
    .orderBy(asc(triggerSeenItemsTable.itemKey));
  return rows.map((r) => r.k);
}

async function row(id: number) {
  const [r] = await db.select().from(agentTriggersTable).where(eq(agentTriggersTable.id, id));
  return r!;
}

describe("creazione e lettura", () => {
  it("poll valido → 201 in pausa, senza segreti nella risposta", async () => {
    const { agentId, toolId } = await seed();
    const res = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: "poll", status: "paused", name: "Email", toolId, intervalSeconds: 300, baselineDone: false });
    expect(res.json.webhookUrl).toBeNull();
    expect(res.json).not.toHaveProperty("secretHash");
    expect(res.json).not.toHaveProperty("signingSecretEnc");
    expect((await row(res.json.id)).nextPollAt).not.toBeNull();
    const list = await api("GET", `/agents/${agentId}/triggers`);
    expect(list.status).toBe(200);
    expect(list.json.map((t: { id: number }) => t.id)).toEqual([res.json.id]);
  });

  it("webhook → 201 con l'indirizzo una volta sola; il GET non lo contiene", async () => {
    const { agentId } = await seed();
    const res = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "GitHub" } });
    expect(res.status).toBe(201);
    expect(res.json.webhookUrl).toMatch(new RegExp(`^${PUBLIC_URL}/api/hooks/${res.json.id}/whs_`));
    expect(res.json.signingSecretSet).toBe(false);
    const got = await api("GET", `/triggers/${res.json.id}`);
    expect(got.status).toBe(200);
    expect(got.json).not.toHaveProperty("webhookUrl");
    expect(JSON.stringify(got.json)).not.toContain("whs_");
    expect(got.json).not.toHaveProperty("secretHash");
  });

  it("agente inesistente → 404; innesco inesistente → 404", async () => {
    await seed();
    expect((await api("POST", `/agents/999999/triggers`, { body: { kind: "webhook", name: "X" } })).status).toBe(404);
    expect((await api("GET", `/agents/999999/triggers`)).status).toBe(404);
    const missing = await api("GET", `/triggers/999999`);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe(TRIGGER_MESSAGES.notFound);
  });

  it("tool L1, tool con identità user o di un'altra app → 400 toolNotUsable", async () => {
    const { agentId, toolId } = await seed();
    await db.update(appToolsTable).set({ level: "L1" }).where(eq(appToolsTable.id, toolId));
    let res = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(TRIGGER_MESSAGES.toolNotUsable);

    await db.update(appToolsTable).set({ level: "L0", identity: "user" }).where(eq(appToolsTable.id, toolId));
    res = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    expect(res.json.error).toBe(TRIGGER_MESSAGES.toolNotUsable);

    const other = await seed();
    res = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(other.toolId) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(TRIGGER_MESSAGES.toolNotUsable);
  });

  it("argomenti non conformi a params_schema → 400", async () => {
    const { agentId, toolId } = await seed();
    const res = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId, { args: { box: 3 } }) });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(TRIGGER_MESSAGES.invalidArgs);
    const extra = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId, { args: { altro: "x" } }) });
    expect(extra.status).toBe(400);
  });

  it("51° innesco dello stesso utente → 409 tooMany", async () => {
    const { agentId } = await seed();
    const first = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W0" } });
    expect(first.status).toBe(201);
    const userId = first.json.createdBy as number;
    // Altri 49 inneschi dello stesso utente su un altro agente (inseriti direttamente: il limite per agente non conta qui)
    const [other] = await db.insert(agentsTable).values({ appId: (await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)))[0]!.appId, name: "Altro", role: "area" }).returning();
    await db.insert(agentTriggersTable).values(
      Array.from({ length: 49 }, (_, i) => ({ agentId: other!.id, kind: "webhook" as const, name: `W${i + 1}`, secretHash: "0".repeat(64), createdBy: userId })),
    );
    const res = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "Troppi" } });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(TRIGGER_MESSAGES.tooMany);
  });

  it("11° innesco sull'agente → 409 tooMany; nome ripetuto → 409 nameTaken", async () => {
    const { agentId } = await seed();
    const dup = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W0" } });
    expect(dup.status).toBe(201);
    const again = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W0" } });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe(TRIGGER_MESSAGES.nameTaken);
    for (let i = 1; i < 10; i++) {
      expect((await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: `W${i}` } })).status).toBe(201);
    }
    const eleventh = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W10" } });
    expect(eleventh.status).toBe(409);
    expect(eleventh.json.error).toBe(TRIGGER_MESSAGES.tooMany);
  });
});

describe("modifica, pausa e ripresa", () => {
  it("PATCH di itemsPath azzera linea di partenza, cursore e chiavi; PATCH del nome no", async () => {
    const { agentId, toolId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    const id = created.json.id as number;
    await db.update(agentTriggersTable).set({ baselineDone: true, cursorValue: "2026-11-01" }).where(eq(agentTriggersTable.id, id));
    await db.insert(triggerSeenItemsTable).values([{ triggerId: id, itemKey: "1" }, { triggerId: id, itemKey: "2" }]);

    const renamed = await api("PATCH", `/triggers/${id}`, { body: { name: "Posta" } });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ name: "Posta", baselineDone: true, cursorValue: "2026-11-01" });
    expect(await seenKeys(id)).toEqual(["1", "2"]);

    const moved = await api("PATCH", `/triggers/${id}`, { body: { itemsPath: "items" } });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ itemsPath: "items", baselineDone: false, cursorValue: null });
    expect(await seenKeys(id)).toEqual([]);
  });

  it.each([
    ["toolId", "tool"],
    ["idField", { idField: "uid" }],
    ["versionField", { versionField: "rev" }],
    ["filter", { filter: { field: "box", equals: "in" } }],
  ] as const)("PATCH di %s rifà la linea di partenza", async (_field, change) => {
    const { appId, agentId, toolId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    const id = created.json.id as number;
    await db.update(agentTriggersTable).set({ baselineDone: true, cursorValue: "c" }).where(eq(agentTriggersTable.id, id));
    await db.insert(triggerSeenItemsTable).values({ triggerId: id, itemKey: "1" });
    let body: Record<string, unknown>;
    if (change === "tool") {
      const [other] = await db
        .insert(appToolsTable)
        .values({
          appId,
          name: "elenco_bis",
          kind: "http",
          identity: "service",
          level: "L0",
          status: "active",
          description: "Altre email",
          definition: { method: "GET", path: "/emails", paramLocations: { box: "query" } },
          paramsSchema: { type: "object", properties: { box: { type: "string" } } },
        })
        .returning();
      body = { toolId: other!.id };
    } else {
      body = change;
    }
    const res = await api("PATCH", `/triggers/${id}`, { body });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ baselineDone: false, cursorValue: null });
    expect(await seenKeys(id)).toEqual([]);
  });

  it("PATCH con un nome già usato → 409; con argomenti non validi → 400", async () => {
    const { agentId, toolId } = await seed();
    await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "Altro" } });
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    const taken = await api("PATCH", `/triggers/${created.json.id}`, { body: { name: "Altro" } });
    expect(taken.status).toBe(409);
    expect(taken.json.error).toBe(TRIGGER_MESSAGES.nameTaken);
    const bad = await api("PATCH", `/triggers/${created.json.id}`, { body: { args: { box: 1 } } });
    expect(bad.status).toBe(400);
  });

  it("pause e resume; resume di un innesco in errore lo riattiva e il giro parte subito", async () => {
    const { agentId, toolId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    const id = created.json.id as number;
    const future = new Date(Date.now() + 3600_000);
    await db
      .update(agentTriggersTable)
      .set({ status: "error", consecutiveErrors: 10, lastError: "x", nextPollAt: future })
      .where(eq(agentTriggersTable.id, id));
    const before = Date.now();
    const resumed = await api("POST", `/triggers/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ status: "active", consecutiveErrors: 0, lastError: null });
    expect(new Date(resumed.json.nextPollAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(resumed.json.nextPollAt).getTime()).toBeGreaterThan(before - 5_000);
    const paused = await api("POST", `/triggers/${id}/pause`);
    expect(paused.status).toBe(200);
    expect(paused.json.status).toBe("paused");
  });

  it("DELETE elimina l'innesco: le sue run restano senza innesco", async () => {
    const { agentId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W" } });
    const [run] = await db.insert(runsTable).values({ agentId, status: "pending", triggerId: created.json.id }).returning();
    expect((await api("DELETE", `/triggers/${created.json.id}`)).status).toBe(204);
    expect((await api("GET", `/triggers/${created.json.id}`)).status).toBe(404);
    const [after] = await db.select().from(runsTable).where(eq(runsTable.id, run!.id));
    expect(after!.triggerId).toBeNull();
  });
});

describe("prova", () => {
  it("configurazione non salvata: elementi nuovi con anteprima ≤ 200, nessuna run né chiave", async () => {
    const { agentId, toolId } = await seed();
    const res = await api("POST", `/agents/${agentId}/triggers/test`, { body: pollInput(toolId) });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ total: 2, newCount: 2, errors: [] });
    expect(res.json.items.map((i: { key: string; isNew: boolean }) => [i.key, i.isNew])).toEqual([
      ["1", true],
      ["2", true],
    ]);
    for (const item of res.json.items) expect(item.preview.length).toBeLessThanOrEqual(200);
    expect(res.json.items[0].preview).toContain("Prima");
    expect(await db.select().from(runsTable)).toEqual([]);
    expect(await db.select().from(triggerSeenItemsTable)).toEqual([]);
    expect(await db.select().from(agentTriggersTable)).toEqual([]);
  });

  it("innesco salvato: isNew rispetto alle chiavi viste, cursore e chiavi invariati", async () => {
    const { agentId, toolId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) });
    const id = created.json.id as number;
    await db.insert(triggerSeenItemsTable).values({ triggerId: id, itemKey: "1" });
    const res = await api("POST", `/triggers/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.json.newCount).toBe(1);
    expect(res.json.items.map((i: { isNew: boolean }) => i.isNew)).toEqual([false, true]);
    expect(await seenKeys(id)).toEqual(["1"]);
    expect(await db.select().from(runsTable)).toEqual([]);
  });

  it("elenco assente → 200 con l'errore fisso, nessun elemento", async () => {
    const { agentId, toolId } = await seed();
    appBody = { altro: true };
    const res = await api("POST", `/agents/${agentId}/triggers/test`, { body: pollInput(toolId) });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ items: [], total: 0, newCount: 0, errors: [TRIGGER_MESSAGES.listNotFound] });
  });

  it("prova su un webhook → 400; la settima prova in un minuto → 429", async () => {
    const { agentId, toolId } = await seed();
    const hook = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W" } });
    expect((await api("POST", `/triggers/${hook.json.id}/test`)).status).toBe(400);
    expect((await api("POST", `/agents/${agentId}/triggers/test`, { body: { kind: "webhook", name: "W" } })).status).toBe(400);
    for (let i = 0; i < 4; i++) {
      expect((await api("POST", `/agents/${agentId}/triggers/test`, { body: pollInput(toolId) })).status).toBe(200);
    }
    const seventh = await api("POST", `/agents/${agentId}/triggers/test`, { body: pollInput(toolId) });
    expect(seventh.status).toBe(429);
  });
});

describe("segreti del webhook", () => {
  it("POST /secret con un token personale → 403; con la sessione nuovo indirizzo e il vecchio segreto dà 404", async () => {
    const { ownerId, agentId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W" } });
    const id = created.json.id as number;
    await db.update(agentTriggersTable).set({ status: "active" }).where(eq(agentTriggersTable.id, id));
    const token = await tokenWith(ownerId, ["api:write"]);
    expect((await api("POST", `/triggers/${id}/secret`, { token })).status).toBe(403);
    expect((await api("PUT", `/triggers/${id}/signing-secret`, { token, body: { secret: "s".repeat(20) } })).status).toBe(403);

    const regenerated = await api("POST", `/triggers/${id}/secret`);
    expect(regenerated.status).toBe(200);
    expect(regenerated.json.webhookUrl).toMatch(new RegExp(`^${PUBLIC_URL}/api/hooks/${id}/whs_`));
    expect(regenerated.json.webhookUrl).not.toBe(created.json.webhookUrl);

    const path = (url: string) => url.slice(PUBLIC_URL.length);
    const send = (url: string) =>
      fetch(`${base}${path(url)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await send(created.json.webhookUrl)).status).toBe(404);
    expect((await send(regenerated.json.webhookUrl)).status).toBe(202);
  });

  it("PUT /signing-secret: 10 caratteri → 400, valido → impostato, null → tolto", async () => {
    const { agentId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "W" } });
    const id = created.json.id as number;
    expect((await api("PUT", `/triggers/${id}/signing-secret`, { body: { secret: "s".repeat(10) } })).status).toBe(400);
    const set = await api("PUT", `/triggers/${id}/signing-secret`, { body: { secret: "s".repeat(20) } });
    expect(set.status).toBe(200);
    expect(set.json.signingSecretSet).toBe(true);
    expect(JSON.stringify(set.json)).not.toContain("s".repeat(20));
    expect((await row(id)).signingSecretEnc).not.toBeNull();
    const cleared = await api("PUT", `/triggers/${id}/signing-secret`, { body: { secret: null } });
    expect(cleared.json.signingSecretSet).toBe(false);
    expect((await row(id)).signingSecretEnc).toBeNull();
  });
});

describe("ambiti, tool, dashboard e run", () => {
  it("token con solo api:read: GET ok, POST 403", async () => {
    const { ownerId, agentId } = await seed();
    const token = await tokenWith(ownerId, ["api:read"]);
    expect((await api("GET", `/agents/${agentId}/triggers`, { token })).status).toBe(200);
    expect((await api("POST", `/agents/${agentId}/triggers`, { token, body: { kind: "webhook", name: "W" } })).status).toBe(403);
  });

  it("eliminare un tool usato da un innesco → 409 toolInUse", async () => {
    const { appId, agentId, toolId } = await seed();
    expect((await api("POST", `/agents/${agentId}/triggers`, { body: pollInput(toolId) })).status).toBe(201);
    const res = await api("DELETE", `/apps/${appId}/tools/${toolId}`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(TRIGGER_MESSAGES.toolInUse);
  });

  it("dashboard: triggersInError conta gli inneschi in errore", async () => {
    const { agentId } = await seed();
    const a = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "A" } });
    await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "B" } });
    await db.update(agentTriggersTable).set({ status: "error" }).where(eq(agentTriggersTable.id, a.json.id));
    const stats = await api("GET", "/dashboard/stats");
    expect(stats.status).toBe(200);
    expect(stats.json.triggersInError).toBe(1);
  });

  it("run d'innesco: triggerId e triggerName nel dettaglio, nell'elenco e nelle run dell'innesco", async () => {
    const { agentId } = await seed();
    const created = await api("POST", `/agents/${agentId}/triggers`, { body: { kind: "webhook", name: "GitHub" } });
    const [run] = await db.insert(runsTable).values({ agentId, status: "pending", triggerId: created.json.id }).returning();
    const [manual] = await db.insert(runsTable).values({ agentId, status: "pending" }).returning();
    const detail = await api("GET", `/runs/${run!.id}`);
    expect(detail.json).toMatchObject({ triggerId: created.json.id, triggerName: "GitHub" });
    const plain = await api("GET", `/runs/${manual!.id}`);
    expect(plain.json).toMatchObject({ triggerId: null, triggerName: null });
    const list = await api("GET", `/runs?agentId=${agentId}`);
    expect(list.json.find((r: { id: number }) => r.id === run!.id)).toMatchObject({ triggerName: "GitHub" });
    const ofTrigger = await api("GET", `/triggers/${created.json.id}/runs`);
    expect(ofTrigger.status).toBe(200);
    expect(ofTrigger.json.map((r: { id: number }) => r.id)).toEqual([run!.id]);
  });
});
