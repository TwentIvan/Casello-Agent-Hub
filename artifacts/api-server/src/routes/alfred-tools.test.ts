import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  alfredConfirmationsTable,
  alfredSessionsTable,
  appToolsTable,
  appsTable,
  pendingActionsTable,
  teamEventsTable,
  teamTasksTable,
  teamTurnsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { startFakeMcp, type FakeMcp } from "../../test/fake-mcp";
import { enqueueAction, enqueuePlanItem } from "../lib/actions/queue";
import { encryptSecret } from "../lib/secrets";
import type { CatalogTool } from "../lib/tools/types";
import { emitEvent } from "../lib/teams/events";
import { createInstance } from "../lib/teams/instances";
import { writePlanVersion } from "../lib/teams/plan";
import { activateInstance } from "../lib/teams/turn-runner";
import { confirmDecision } from "../lib/alfred/confirmations";
import { consumeActionDecision, consumeTeamMessage } from "../middlewares/rate-limit";

// Strumenti di Alfred su /api/alfred/sessions/:id/tools/:name e conferma a doppio passo. App completa senza login
// (utente dev@localhost). Nessun RESTART IDENTITY: i limiti sono per utente in memoria e gli id non devono ripetersi.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

let base: string;
let server: http.Server;
let fake: FakeProvider;
let mcpApp: FakeMcp;
let restoreLoopback: () => void;
let dev: number;
let other: number;
let modelId: number;
let appId: number;
let tool: CatalogTool;
let sessionId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const run = (name: string, args: unknown = {}, id: number = sessionId) => api("POST", `/alfred/sessions/${id}/tools/${name}`, { args });

async function accountModel(owner: number, name: string): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: owner, name, provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" }).returning();
  return model!.id;
}

async function activeTeam(owner: number, name: string, ownerModel: number): Promise<number> {
  const created = await createInstance(owner, {
    name,
    ref: { appId, type: "wi", id: name },
    roles: [{ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: ownerModel, tools: [], skills: [], localSkills: [] }],
  });
  await activateInstance(owner, created.id);
  return created.id;
}

async function newSession(userId: number): Promise<number> {
  const [row] = await db.insert(alfredSessionsTable).values({ userId }).returning();
  return row!.id;
}

async function queueAction(userId = dev, t: CatalogTool = tool): Promise<number> {
  const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool: t, args: { id: "42" }, recipient: "Rosa", summary: "Imposta la password" });
  if (!out.ok) throw new Error("accodamento");
  return out.number;
}

async function statusOf(n: number) {
  return (await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, n)))[0]!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost,altro@example.com";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  restoreLoopback = allowTestLoopback();
  mcpApp = await startFakeMcp({ tools: [{ name: "set_pw", text: "fatto" }] });
  const { default: app } = await import("../app");
  server = http.createServer(app);
  base = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await mcpApp.close();
  restoreLoopback();
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  fake = await startFakeProvider();
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users CASCADE");
  await api("GET", "/auth/me");
  dev = (await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost")))[0]!.id;
  other = (await db.insert(usersTable).values({ email: "altro@example.com" }).returning())[0]!.id;
  modelId = await accountModel(dev, "A");
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example", mcpUrl: mcpApp.url, serviceAuth: { header: "X-Key", scheme: null }, serviceSecretEnc: encryptSecret("seg") })
    .returning();
  appId = app!.id;
  const [row] = await db
    .insert(appToolsTable)
    .values({ appId, name: "set_pw", kind: "mcp", identity: "service", level: "L2", status: "active", paramsSchema: SCHEMA, definition: { mcpName: "set_pw" } } as InsertAppTool)
    .returning();
  tool = { ...row!, paramsSchema: SCHEMA, definition: row!.definition as CatalogTool["definition"] };
  sessionId = await newSession(dev);
});

afterEach(async () => {
  mcpApp.calls.length = 0;
  await fake.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("strumenti di lettura", () => {
  it("squadre_stato e bollettino restituiscono i dati dell'utente; il bollettino segna letti", async () => {
    const mine = await activeTeam(dev, "Mia", modelId);
    const theirs = await activeTeam(other, "Altrui", await accountModel(other, "B"));
    await emitEvent({ instanceId: mine, type: "piano_proposto", bulletin: "Piano pronto" });
    await emitEvent({ instanceId: theirs, type: "bloccato", bulletin: "Segreto altrui" });
    const st = await run("squadre_stato");
    expect(st.status).toBe(200);
    expect(st.json.ok).toBe(true);
    expect(st.json.result.lines).toHaveLength(1);
    expect(JSON.stringify(st.json)).not.toContain("Altrui");
    const b = await run("bollettino");
    expect(b.json.result.events).toHaveLength(1);
    expect(b.json.result.events[0]).toMatchObject({ teamId: mine, text: "Piano pronto" });
    expect((await run("bollettino")).json.result.events).toEqual([]);
    const [o] = await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, theirs));
    expect(o!.readAt).toBeNull();
  });

  it("squadra_dettaglio: al più 5 compiti e 5 eventi, solo l'id della squadra; squadra altrui → squadra non trovata", async () => {
    const mine = await activeTeam(dev, "Mia", modelId);
    const theirs = await activeTeam(other, "Altrui", await accountModel(other, "B"));
    await writePlanVersion(mine, { objective: "Consegnare", constraints: [], openPoints: [], tasks: [], manualActions: [] }, "proposed");
    await db.insert(teamTasksTable).values(Array.from({ length: 8 }, (_, i) => ({ instanceId: mine, planTaskId: `t${i}`, roleKey: "capo", instructions: "x", status: "done" as const, outcome: "ok" })));
    for (let i = 0; i < 8; i++) await emitEvent({ instanceId: mine, type: "compito_finito", bulletin: `Evento ${i}` });
    const res = await run("squadra_dettaglio", { id: mine });
    expect(res.json.ok).toBe(true);
    expect(res.json.result).toMatchObject({ id: mine, name: "Mia", objective: "Consegnare", planStatus: "proposed" });
    expect(res.json.result.tasks).toHaveLength(5);
    expect(res.json.result.events).toHaveLength(5);
    const text = JSON.stringify(res.json.result);
    expect(text).not.toMatch(/"(planTaskId|roleKey|teamId|taskId)"/);
    expect(res.json.result.tasks[0]).toEqual({ title: expect.any(String), status: "done", outcome: "ok" });
    expect(await run("squadra_dettaglio", { id: theirs })).toMatchObject({ status: 200, json: { ok: false, error: "squadra non trovata" } });
  });

  it("coda_da_confermare elenca solo le voci dell'utente", async () => {
    const n = await queueAction();
    await queueAction(other);
    const res = await run("coda_da_confermare");
    expect(res.json.result.actions).toHaveLength(1);
    expect(res.json.result.actions[0]).toMatchObject({ numero: n, sintesi: "Imposta la password", serveTokenApp: false });
  });
});

describe("scrivi_al_capo e validazione", () => {
  it("accoda un turno request; l'undicesimo messaggio del minuto (anche da POST messages) è rifiutato", async () => {
    const mine = await activeTeam(dev, "Mia", modelId);
    const ok = await run("scrivi_al_capo", { id: mine, testo: "Procedi" });
    expect(ok.json).toMatchObject({ ok: true, result: { queued: true } });
    const turns = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, mine));
    expect(JSON.stringify(turns.map((t) => t.reasons))).toContain("Procedi");
    for (let i = 0; i < 9; i++) expect(consumeTeamMessage(dev)).toBe(true);
    const over = await run("scrivi_al_capo", { id: mine, testo: "Ancora" });
    expect(over.json).toEqual({ ok: false, error: "Troppe richieste: riprova tra poco" });
  });

  it("strumento sconosciuto 404, argomenti non validi ok:false, sessione chiusa o altrui 404", async () => {
    expect(await run("non_esiste")).toMatchObject({ status: 404, json: { error: "strumento non trovato" } });
    const bad = await run("scrivi_al_capo", { id: "x" });
    expect(bad).toMatchObject({ status: 200, json: { ok: false } });
    expect((await run("prepara_decisione", { numero: 1, decisione: "forse" })).json.ok).toBe(false);
    expect((await run("squadre_stato", {}, await newSession(other))).status).toBe(404);
    await db.update(alfredSessionsTable).set({ status: "closed" }).where(eq(alfredSessionsTable.id, sessionId));
    expect(await run("squadre_stato")).toMatchObject({ status: 404, json: { error: "sessione non trovata" } });
  });
});

describe("prepara_decisione", () => {
  it("riuscita: codice di 6 cifre, riepilogo, nel DB solo l'hash", async () => {
    const n = await queueAction();
    const res = await run("prepara_decisione", { numero: n, decisione: "approva" });
    expect(res.json.ok).toBe(true);
    expect(res.json.result).toEqual({ codice: expect.stringMatching(/^\d{6}$/), numero: n, tipo: "azione", squadra: null, sintesi: "Imposta la password", decisione: "approva" });
    const rows = await db.select().from(alfredConfirmationsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.codeHash).not.toContain(res.json.result.codice);
    expect(JSON.stringify(rows[0])).not.toContain(res.json.result.codice);
    expect((await statusOf(n)).status).toBe("pending");
  });

  it("voce non in attesa, inesistente, o con token utente da approvare in console", async () => {
    const n = await queueAction();
    await db.update(pendingActionsTable).set({ status: "done" }).where(eq(pendingActionsTable.number, n));
    expect(await run("prepara_decisione", { numero: n, decisione: "rifiuta" })).toMatchObject({ json: { ok: false, error: "voce non in attesa" } });
    expect(await run("prepara_decisione", { numero: 999, decisione: "rifiuta" })).toMatchObject({ json: { ok: false, error: "voce non in attesa" } });
    const [userTool] = await db
      .insert(appToolsTable)
      .values({ appId, name: "set_user", kind: "mcp", identity: "user", level: "L2", status: "active", paramsSchema: SCHEMA, definition: { mcpName: "set_pw" } } as InsertAppTool)
      .returning();
    const m = await queueAction(dev, { ...userTool!, paramsSchema: SCHEMA, definition: userTool!.definition as CatalogTool["definition"] });
    expect(await run("prepara_decisione", { numero: m, decisione: "approva" })).toMatchObject({
      json: { ok: false, error: "questa voce va approvata dalla console: serve il token dell'app" },
    });
    expect((await run("prepara_decisione", { numero: m, decisione: "rifiuta" })).json.ok).toBe(true);
  });

  it("due preparazioni di fila: vale solo l'ultimo codice", async () => {
    const n = await queueAction();
    const first = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    const second = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    expect((await run("conferma_decisione", { codice: first })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect((await statusOf(n)).status).toBe("pending");
    expect((await run("conferma_decisione", { codice: second })).json.ok).toBe(true);
  });
});

describe("prepara_decisione: errori", () => {
  it("una preparazione fallita invalida il codice precedente della sessione", async () => {
    const a = await queueAction();
    const b = await queueAction();
    const codeA = (await run("prepara_decisione", { numero: a, decisione: "approva" })).json.result.codice;
    await db.update(pendingActionsTable).set({ status: "done" }).where(eq(pendingActionsTable.number, b));
    expect((await run("prepara_decisione", { numero: b, decisione: "approva" })).json.ok).toBe(false);
    expect((await run("conferma_decisione", { codice: codeA })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect((await statusOf(a)).status).toBe("pending");
  });

  it("nota con approva rifiutata; nota oltre 500 caratteri argomenti non validi", async () => {
    const n = await queueAction();
    expect((await run("prepara_decisione", { numero: n, decisione: "approva", nota: "x" })).json).toEqual({ ok: false, error: "la nota si può dare solo con il rifiuto" });
    expect((await run("prepara_decisione", { numero: n, decisione: "rifiuta", nota: "x".repeat(501) })).json).toEqual({ ok: false, error: "argomenti non validi" });
  });
});

describe("conferma_decisione", () => {
  it("approva: esegue l'azione una volta; rifiuta: chiude con la nota", async () => {
    const a = await queueAction();
    const code = (await run("prepara_decisione", { numero: a, decisione: "approva" })).json.result.codice;
    const done = await run("conferma_decisione", { codice: code });
    expect(done.json).toMatchObject({ ok: true, result: { numero: a, esito: "approvata" } });
    expect(mcpApp.calls).toHaveLength(1);
    expect((await run("conferma_decisione", { codice: code })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect(mcpApp.calls).toHaveLength(1);

    const team = await activeTeam(dev, "Mia", modelId);
    const view = await writePlanVersion(team, { objective: "O", constraints: [], openPoints: [], tasks: [], manualActions: [] }, "proposed");
    const item = await enqueuePlanItem({ userId: dev, instanceId: team, kind: "plan", planVersion: view.version, recipient: "Mia", summary: "Piano", detail: { objective: "O" } });
    if (!item.ok) throw new Error("accodamento");
    const prep = await run("prepara_decisione", { numero: item.number, decisione: "rifiuta", nota: "manca il budget" });
    expect(prep.json.result).toMatchObject({ tipo: "piano", squadra: "Mia" });
    const rej = await run("conferma_decisione", { codice: prep.json.result.codice });
    expect(rej.json).toMatchObject({ ok: true, result: { numero: item.number, esito: "rifiutata" } });
    const turns = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, team));
    expect(turns.flatMap((t) => t.reasons as unknown[])).toContainEqual({ type: "decision", number: item.number, outcome: "rejected", note: "manca il budget" });
  });

  it("codice sbagliato, scaduto (61 s), di un'altra sessione o di un altro utente: conferma scaduta", async () => {
    const msg = "conferma scaduta: ripeti la richiesta";
    const n = await queueAction();
    expect((await run("conferma_decisione", { codice: "000000" })).json.error).toBe(msg);

    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    const sessionB = await newSession(dev);
    expect((await run("conferma_decisione", { codice: code }, sessionB)).json.error).toBe(msg);
    // altro utente (l'HTTP è sempre dell'utente di sviluppo: si prova la funzione), con la sua sessione o con quella del primo
    await expect(confirmDecision(other, await newSession(other), code)).rejects.toThrow(msg);
    await expect(confirmDecision(other, sessionId, code)).rejects.toThrow(msg);
    expect((await statusOf(n)).status).toBe("pending");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await run("conferma_decisione", { codice: code })).json.error).toBe(msg);
    vi.useRealTimers();
    expect((await statusOf(n)).status).toBe("pending");
    expect(mcpApp.calls).toHaveLength(0);
  });

  it("due conferme concorrenti con lo stesso codice: una sola riesce", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    const results = await Promise.all([run("conferma_decisione", { codice: code }), run("conferma_decisione", { codice: code })]);
    expect(results.filter((r) => r.json.ok)).toHaveLength(1);
    expect(mcpApp.calls).toHaveLength(1);
  });

  it("voce decisa nel frattempo dalla console: messaggio di decide.ts", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    expect((await api("POST", `/pending-actions/${n}/reject`, {})).status).toBe(200);
    expect(await run("conferma_decisione", { codice: code })).toMatchObject({ json: { ok: false, error: "azione già decisa" } });
  });

  it("il limite di 20 decisioni/min è condiviso con la console", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    for (let i = 0; i < 20; i++) consumeActionDecision(dev);
    expect((await run("conferma_decisione", { codice: code })).json.error).toBe("Troppe richieste: riprova tra poco");
    expect((await statusOf(n)).status).toBe("pending");
    expect(mcpApp.calls).toHaveLength(0);
  });
});
