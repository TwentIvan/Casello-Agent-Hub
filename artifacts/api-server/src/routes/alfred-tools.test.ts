import http from "node:http";
import { alfredInstructions } from "../lib/alfred/instructions";
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
  agentsTable,
  appsTable,
  runsTable,
  pendingActionsTable,
  teamEventsTable,
  teamTasksTable,
  teamTurnsTable,
  pendingActionStepsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../test/fake-provider";
import { startFakeMcp, type FakeMcp } from "../../test/fake-mcp";
import { enqueueAction, enqueuePlanItem } from "../lib/actions/queue";
import { queueTestProposal } from "../../test/proposal-fixture";
import { encryptSecret } from "../lib/secrets";
import type { CatalogTool } from "../lib/tools/types";
import { emitEvent } from "../lib/teams/events";
import { createInstance } from "../lib/teams/instances";
import { writePlanVersion } from "../lib/teams/plan";
import { activateInstance } from "../lib/teams/turn-runner";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import { ALFRED_TOOL_DECLARATIONS } from "../lib/alfred/tool-declarations";
import { confirmDecision } from "../lib/alfred/confirmations";
import { consumeActionDecision, consumeAlfredTool, consumeTeamMessage } from "../middlewares/rate-limit";

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

// Le conferme arrivano dopo almeno 2 s dalla preparazione: i test retrodatano la riga invece di aspettare
async function confirm(args: unknown, id: number = sessionId) {
  await db.update(alfredConfirmationsTable).set({ createdAt: new Date(Date.now() - 5000) });
  return run("conferma_decisione", args, id);
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
    roles: [{ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: ownerModel, tools: [], code: "none", skills: [], localSkills: [] }],
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

describe("Responsabili di prodotto", () => {
  it("elenca_app ok; chiedi_al_responsabile con app inesistente e leggi_run altrui hanno messaggi fissi; dichiarazioni presenti", async () => {
    expect((await run("elenca_app")).json).toMatchObject({ ok: true });
    expect((await run("chiedi_al_responsabile", { richiesta: "ciao", app: "x" })).json).toEqual({ ok: false, error: "App x non trovata: chiedi a elenca_app" });
    const [agentApp] = await db.select().from(appsTable).limit(1);
    const [ag] = await db.insert(agentsTable).values({ appId: agentApp!.id, name: "G", role: "general" }).returning();
    const [otherAcc] = await db.insert(aiAccountsTable).values({ userId: other, name: "B", provider: "custom", baseUrl: "http://y.example", apiKeyEnc: "x", status: "ok" }).returning();
    const [om] = await db.insert(aiModelsTable).values({ accountId: otherAcc!.id, modelId: "mo", displayName: "MO" }).returning();
    const [theirs] = await db.insert(runsTable).values({ agentId: ag!.id, aiModelId: om!.id, status: "succeeded", output: "ok" }).returning();
    expect((await run("leggi_run", { id: theirs!.id })).json).toEqual({ ok: false, error: "run non trovata" });
    const names = ALFRED_TOOL_DECLARATIONS.map((d) => d["name"]);
    expect(names).toEqual(expect.arrayContaining(["elenca_app", "chiedi_al_responsabile", "leggi_run"]));
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
    expect((await confirm({ codice: first })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect((await statusOf(n)).status).toBe("pending");
    expect((await confirm({ codice: second })).json.ok).toBe(true);
  });
});

describe("prepara_decisione: errori", () => {
  it("una preparazione fallita invalida il codice precedente della sessione", async () => {
    const a = await queueAction();
    const b = await queueAction();
    const codeA = (await run("prepara_decisione", { numero: a, decisione: "approva" })).json.result.codice;
    await db.update(pendingActionsTable).set({ status: "done" }).where(eq(pendingActionsTable.number, b));
    expect((await run("prepara_decisione", { numero: b, decisione: "approva" })).json.ok).toBe(false);
    expect((await confirm({ codice: codeA })).json.error).toBe("conferma scaduta: ripeti la richiesta");
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
    const done = await confirm({ codice: code });
    expect(done.json).toMatchObject({ ok: true, result: { numero: a, esito: "approvata" } });
    expect(mcpApp.calls).toHaveLength(1);
    expect((await confirm({ codice: code })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect(mcpApp.calls).toHaveLength(1);

    const team = await activeTeam(dev, "Mia", modelId);
    const view = await writePlanVersion(team, { objective: "O", constraints: [], openPoints: [], tasks: [], manualActions: [] }, "proposed");
    const item = await enqueuePlanItem({ userId: dev, instanceId: team, kind: "plan", planVersion: view.version, recipient: "Mia", summary: "Piano", detail: { objective: "O" } });
    if (!item.ok) throw new Error("accodamento");
    const prep = await run("prepara_decisione", { numero: item.number, decisione: "rifiuta", nota: "manca il budget" });
    expect(prep.json.result).toMatchObject({ tipo: "piano", squadra: "Mia" });
    const rej = await confirm({ codice: prep.json.result.codice });
    expect(rej.json).toMatchObject({ ok: true, result: { numero: item.number, esito: "rifiutata" } });
    const turns = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, team));
    expect(turns.flatMap((t) => t.reasons as unknown[])).toContainEqual({ type: "decision", number: item.number, outcome: "rejected", note: "manca il budget" });
  });

  it("codice sbagliato, scaduto (61 s), di un'altra sessione o di un altro utente: conferma scaduta", async () => {
    const msg = "conferma scaduta: ripeti la richiesta";
    const n = await queueAction();
    expect((await confirm({ codice: "000000" })).json.error).toBe(msg);

    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    const sessionB = await newSession(dev);
    expect((await confirm({ codice: code }, sessionB)).json.error).toBe(msg);
    // altro utente (l'HTTP è sempre dell'utente di sviluppo: si prova la funzione), con la sua sessione o con quella del primo
    await expect(confirmDecision(other, await newSession(other), code)).rejects.toThrow(msg);
    await expect(confirmDecision(other, sessionId, code)).rejects.toThrow(msg);
    expect((await statusOf(n)).status).toBe("pending");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await confirm({ codice: code })).json.error).toBe(msg);
    vi.useRealTimers();
    expect((await statusOf(n)).status).toBe("pending");
    expect(mcpApp.calls).toHaveLength(0);
  });

  it("due conferme concorrenti con lo stesso codice: una sola riesce", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    const results = await Promise.all([confirm({ codice: code }), confirm({ codice: code })]);
    expect(results.filter((r) => r.json.ok)).toHaveLength(1);
    expect(mcpApp.calls).toHaveLength(1);
  });

  it("voce decisa nel frattempo dalla console: messaggio di decide.ts", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    expect((await api("POST", `/pending-actions/${n}/reject`, {})).status).toBe(200);
    expect(await confirm({ codice: code })).toMatchObject({ json: { ok: false, error: "azione già decisa" } });
  });

  it("il limite di 20 decisioni/min è condiviso con la console", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    for (let i = 0; i < 20; i++) consumeActionDecision(dev);
    expect((await confirm({ codice: code })).json.error).toBe("Troppe richieste: riprova tra poco");
    expect((await statusOf(n)).status).toBe("pending");
    expect(mcpApp.calls).toHaveLength(0);
  });
});

describe("indurimento della conferma", () => {
  it("un codice numerico con zeri iniziali vale come stringa di 6 cifre", async () => {
    const n = await queueAction();
    await db.insert(alfredConfirmationsTable).values({
      userId: dev,
      sessionId,
      number: n,
      decision: "reject",
      codeHash: createHash("sha256").update("000042").digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 5000),
    });
    expect(await run("conferma_decisione", { codice: 42 })).toMatchObject({ json: { ok: true, result: { numero: n, esito: "rifiutata" } } });
  });

  it("con il fuso del DB diverso da UTC la conferma dopo 2 s riesce (orari scritti dall'API)", async () => {
    await pool.query("SET TIME ZONE 'Etc/GMT-1'");
    try {
      const n = await queueAction();
      const code = (await run("prepara_decisione", { numero: n, decisione: "rifiuta" })).json.result.codice;
      await new Promise((r) => setTimeout(r, 2100));
      expect(await run("conferma_decisione", { codice: code })).toMatchObject({ json: { ok: true, result: { numero: n, esito: "rifiutata" } } });
    } finally {
      await pool.query("SET TIME ZONE 'UTC'");
    }
  });

  it("una conferma entro 2 s dalla preparazione è rifiutata e invalida il codice", async () => {
    const n = await queueAction();
    const code = (await run("prepara_decisione", { numero: n, decisione: "approva" })).json.result.codice;
    expect((await run("conferma_decisione", { codice: code })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect((await statusOf(n)).status).toBe("pending");
    expect((await confirm({ codice: code })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    expect(mcpApp.calls).toHaveLength(0);
  });

  it("un errore del DB sulle conferme risponde 500 fisso e non registra il testo dell'errore", async () => {
    const n = await queueAction();
    const logged: string[] = [];
    for (const m of ["error", "warn", "info"] as const) vi.spyOn(logger, m).mockImplementation(((...a: unknown[]) => void logged.push(JSON.stringify(a))) as never);
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("insert ... code_hash = deadbeef"));
    const res = await run("prepara_decisione", { numero: n, decisione: "approva" });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "errore interno" });
    expect(logged.join()).not.toContain("deadbeef");
  });

  it("strumenti: oltre 60 chiamate al minuto per utente → 429", async () => {
    for (let i = 0; i < 60; i++) consumeAlfredTool(dev);
    const res = await run("squadre_stato");
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: "Troppe richieste: riprova tra poco" });
  });
});

describe("proposte multiple", () => {
  const proposal = () => queueTestProposal({ userId: dev, appId, toolId: tool.id, toolName: "set_pw" });
  const stepStates = async (n: number) => {
    const row = await statusOf(n);
    const steps = await db.select().from(pendingActionStepsTable).where(eq(pendingActionStepsTable.pendingActionId, row.id));
    return Object.fromEntries(steps.map((s) => [s.key, s.status]));
  };

  it("coda_da_confermare riporta il numero di passi solo per le proposte", async () => {
    const a = await queueAction();
    const p = await proposal();
    const res = await run("coda_da_confermare");
    const byNumber = new Map(res.json.result.actions.map((x: { numero: number }) => [x.numero, x]));
    expect(byNumber.get(p)).toMatchObject({ numero: p, tipo: "proposal", sintesi: "Nuovo progetto", passi: 3 });
    expect(byNumber.get(a)).not.toHaveProperty("passi");
  });

  it("leggi_proposta: titolo, motivo e passi con numero e sintesi; voce non proposta → proposta non trovata", async () => {
    const a = await queueAction();
    const p = await proposal();
    const res = await run("leggi_proposta", { numero: p });
    expect(res.json).toEqual({
      ok: true,
      result: {
        numero: p,
        titolo: "Nuovo progetto",
        motivo: "Richiesta del cliente",
        stato: "pending",
        passi: [
          { passo: "p1", numero: 1, sintesi: "Crea il progetto", stato: "pending" },
          { passo: "p2", numero: 2, sintesi: "Crea il compito", stato: "pending" },
          { passo: "p3", numero: 3, sintesi: "Commenta il compito", stato: "pending" },
        ],
      },
    });
    expect((await run("leggi_proposta", { numero: a })).json).toEqual({ ok: false, error: "proposta non trovata" });
    expect((await run("leggi_proposta", { numero: 999 })).json).toEqual({ ok: false, error: "proposta non trovata" });
    const theirs = await queueTestProposal({ userId: other, appId, toolId: tool.id, toolName: "set_pw" });
    expect((await run("leggi_proposta", { numero: theirs })).json).toEqual({ ok: false, error: "proposta non trovata" });
  });

  it("prepara_decisione con escludi: passi esclusi e saltati a catena, salvati nella conferma", async () => {
    const p = await proposal();
    const res = await run("prepara_decisione", { numero: p, decisione: "approva", escludi: [2] });
    expect(res.json.ok).toBe(true);
    expect(res.json.result).toMatchObject({ numero: p, tipo: "proposta", sintesi: "Nuovo progetto", passiEsclusi: ["p2"], passiSaltati: ["p3"] });
    const [row] = await db.select().from(alfredConfirmationsTable);
    expect(row!.excludeSteps).toEqual(["p2"]);
    // senza esclusioni: liste vuote
    const plain = await run("prepara_decisione", { numero: p, decisione: "approva" });
    expect(plain.json.result).toMatchObject({ passiEsclusi: [], passiSaltati: [] });
  });

  it("prepara_decisione: escludi con rifiuta, non valido, tutti i passi, su una voce non proposta", async () => {
    const p = await proposal();
    const a = await queueAction();
    // Parte da una conferma davvero aperta: ogni preparazione fallita la deve chiudere
    expect((await run("prepara_decisione", { numero: a, decisione: "rifiuta" })).json.ok).toBe(true);
    const open = await db.select().from(alfredConfirmationsTable).where(eq(alfredConfirmationsTable.sessionId, sessionId));
    expect(open.filter((r) => r.usedAt === null)).toHaveLength(1);
    expect((await run("prepara_decisione", { numero: p, decisione: "rifiuta", escludi: ["p3"] })).json).toEqual({ ok: false, error: "i passi da escludere valgono solo con approva" });
    expect((await run("prepara_decisione", { numero: p, decisione: "approva", escludi: ["p9"] })).json).toEqual({ ok: false, error: "passi da escludere non validi" });
    expect((await run("prepara_decisione", { numero: p, decisione: "approva", escludi: ["x"] })).json).toEqual({ ok: false, error: "passi da escludere non validi" });
    expect((await run("prepara_decisione", { numero: p, decisione: "approva", escludi: [3, "p3"] })).json).toEqual({ ok: false, error: "passi da escludere non validi" });
    expect((await run("prepara_decisione", { numero: p, decisione: "approva", escludi: [1, 2] })).json).toEqual({ ok: false, error: "nessun passo da eseguire: rifiuta la proposta" });
    expect((await run("prepara_decisione", { numero: a, decisione: "approva", escludi: [1] })).json).toEqual({ ok: false, error: "passi da escludere non validi" });
    expect(await db.select().from(alfredConfirmationsTable).where(eq(alfredConfirmationsTable.sessionId, sessionId))).toSatisfy(
      (rows: { usedAt: Date | null }[]) => rows.every((r) => r.usedAt !== null),
    );
  });

  it("una preparazione con escludi non valido invalida il codice precedente", async () => {
    const p = await proposal();
    for (const escludi of [["x"], [3, "p3"], "p3"]) {
      const code = (await run("prepara_decisione", { numero: p, decisione: "approva" })).json.result.codice;
      const bad = await run("prepara_decisione", { numero: p, decisione: "approva", escludi });
      expect(bad.json.ok).toBe(false);
      expect((await confirm({ codice: code })).json.error).toBe("conferma scaduta: ripeti la richiesta");
    }
    expect((await statusOf(p)).status).toBe("pending");
    expect(mcpApp.calls).toHaveLength(0);
  });

  it("conferma_decisione esegue la proposta escludendo i passi preparati", async () => {
    const p = await proposal();
    const code = (await run("prepara_decisione", { numero: p, decisione: "approva", escludi: ["p3"] })).json.result.codice;
    const done = await confirm({ codice: code });
    expect(done.json).toMatchObject({ ok: true, result: { numero: p, esito: "approvata" } });
    expect(await stepStates(p)).toEqual({ p1: "done", p2: "done", p3: "excluded" });
    expect(mcpApp.calls).toHaveLength(2);
    expect((await statusOf(p)).status).toBe("done");
  });
});

describe("istruzioni di Alfred a voce", () => {
  it("istruzioni_responsabili: spiega quando chiamare i Responsabili", () => {
    const t = alfredInstructions("Ivan");
    expect(t).toContain("chiedi_al_responsabile");
    expect(t).toContain("elenca_app");
    expect(t).toContain("non ricorda le richieste precedenti");
    expect(t).toContain("Ogni Responsabile agisce solo sulla sua App");
  });

  it("istruzioni_novita: il messaggio [novità] non viene dall'utente", () => {
    const t = alfredInstructions("Ivan");
    expect(t).toContain("[novità]");
    expect(t).toContain("non viene dall'utente");
  });
});
