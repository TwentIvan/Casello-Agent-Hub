import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appToolsTable,
  appsTable,
  pendingActionsTable,
  teamEventsTable,
  teamTasksTable,
  teamTurnsTable,
  usersTable,
  type InsertAppTool,
} from "@workspace/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeMcp, type FakeMcp } from "../../../test/fake-mcp";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { enqueueAction, enqueuePlanItem } from "../actions/queue";
import { createApiToken } from "../api-tokens";
import { encryptSecret } from "../secrets";
import type { CatalogTool } from "../tools/types";
import { emitEvent } from "../teams/events";
import { createInstance } from "../teams/instances";
import { getPlan, writePlanVersion } from "../teams/plan";
import { activateInstance } from "../teams/turn-runner";
import { setCentralinoModel } from "../ai/default-model";
import { consumeTeamMessage, teamMessageRateLimit } from "../../middlewares/rate-limit";
import { mcpRouter } from "./server";

// Strumenti del centralino su /mcp: dati solo dell'utente del token, coda delle conferme, messaggi al capo.

const SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const savedEnv: Record<string, string | undefined> = {};

let restoreLoopback: () => void;
let httpServer: http.Server;
let url: string;
let fake: FakeProvider;
let mcpApp: FakeMcp;
let userId: number;
let otherId: number;
let token: string;
let otherToken: string;
let modelId: number;
let appId: number;
let tool: CatalogTool;

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; json: any }> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
  return { isError: res.isError === true, json: JSON.parse(res.content[0]!.text!) };
}

async function accountModel(owner: number, name: string): Promise<number> {
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId: owner, name, provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("sk-test"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" }).returning();
  return model!.id;
}

/** Squadra attiva dell'utente (turno `activation` in coda, mai eseguito). */
async function activeTeam(owner: number, name: string, ownerModel: number): Promise<number> {
  const created = await createInstance(owner, {
    name,
    ref: { appId, type: "wi", id: name },
    roles: [{ key: "capo", name: "Capo", task: "", isLead: true, runsOn: "cloud", aiModelId: ownerModel, tools: [], skills: [], localSkills: [] }],
  });
  await activateInstance(owner, created.id);
  return created.id;
}

beforeAll(async () => {
  for (const k of ["ALLOWED_EMAILS", "CASELLO_SECRET_KEY"]) savedEnv[k] = process.env[k];
  process.env["ALLOWED_EMAILS"] = "ivan@example.com,altro@example.com";
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  restoreLoopback = allowTestLoopback();
  mcpApp = await startFakeMcp({ tools: [{ name: "set_pw", text: "fatto" }] });
  const app = express();
  app.use("/mcp", mcpRouter());
  httpServer = http.createServer(app);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
  await mcpApp.close();
  restoreLoopback();
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users CASCADE");
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  fake = await startFakeProvider();
  await pool.query("TRUNCATE team_instances, apps, ai_accounts, users CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com" }).returning();
  const [o] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
  userId = u!.id;
  otherId = o!.id;
  // Il limite dei messaggi al capo è per utente in memoria: ogni test ha utenti nuovi (nessun RESTART IDENTITY)
  token = (await createApiToken(userId, "Mac", 30)).token;
  otherToken = (await createApiToken(otherId, "Mac", 30)).token;
  modelId = await accountModel(userId, "A");
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
});

afterEach(async () => {
  mcpApp.calls.length = 0;
  await fake.close();
  vi.restoreAllMocks();
});

describe("centralino su /mcp", () => {
  it("elenca i sette strumenti del centralino", async () => {
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["squadre_stato", "bollettino", "squadra_dettaglio", "invia_al_capo", "coda_da_confermare", "approva", "rifiuta"]));
    await client.close();
  });

  it("squadre_stato: una riga per squadra attiva dell'utente, senza quelle degli altri", async () => {
    const mine = await activeTeam(userId, "Mia", modelId);
    await activeTeam(otherId, "Altrui", await accountModel(otherId, "B"));
    await db.insert(teamTasksTable).values([
      { instanceId: mine, planTaskId: "t1", roleKey: "capo", instructions: "x", status: "running" },
      { instanceId: mine, planTaskId: "t2", roleKey: "capo", instructions: "x", status: "done" },
      { instanceId: mine, planTaskId: "t3", roleKey: "capo", instructions: "x", status: "done" },
    ]);
    await emitEvent({ instanceId: mine, type: "compito_finito", bulletin: "Fatto t2" });
    const client = await connect(token);
    const out = await call(client, "squadre_stato");
    expect(out.isError).toBe(false);
    expect(out.json.summarized).toBe(false);
    expect(out.json.lines).toHaveLength(1);
    expect(out.json.lines[0]).toContain("Mia");
    expect(out.json.lines[0]).toContain("piano draft");
    expect(out.json.lines[0]).toContain("in corso 1, finiti 2, bloccati 0");
    expect(out.json.lines[0]).toContain("eventi non letti 1");
    expect(JSON.stringify(out.json)).not.toContain("Altrui");
    expect(fake.requests).toHaveLength(0);
    await client.close();
  });

  it("squadre_stato con 6 squadre: riassunto di al massimo 5 righe col modello del centralino; modello in errore → elenco completo", async () => {
    for (let i = 1; i <= 6; i++) await activeTeam(userId, `Squadra ${i}`, modelId);
    const centralino = await accountModel(userId, "Centralino");
    await setCentralinoModel(userId, centralino);
    fake.chatReply = { content: ["a", "b", "c", "d", "e", "f", "g"].join("\n"), toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    const client = await connect(token);

    const summarized = await call(client, "squadre_stato");
    expect(summarized.json).toMatchObject({ summarized: true, teams: 6, lines: ["a", "b", "c", "d", "e"] });
    expect(fake.requests.filter((r) => r.path.endsWith("/chat/completions"))).toHaveLength(1);

    fake.status = 500;
    const failed = await call(client, "squadre_stato");
    expect(failed.isError).toBe(false);
    expect(failed.json.summarized).toBe(false);
    expect(failed.json.lines).toHaveLength(6);
    await client.close();
  });

  it("squadre_stato con 6 squadre e nessun modello: elenco completo senza chiamate", async () => {
    for (let i = 1; i <= 6; i++) await activeTeam(userId, `Squadra ${i}`, modelId);
    const client = await connect(token);
    const out = await call(client, "squadre_stato");
    expect(out.json).toMatchObject({ summarized: false, teams: 6 });
    expect(out.json.lines).toHaveLength(6);
    expect(fake.requests).toHaveLength(0);
    await client.close();
  });

  it("bollettino: restituisce gli eventi non letti dell'utente e li segna letti", async () => {
    const mine = await activeTeam(userId, "Mia", modelId);
    const theirs = await activeTeam(otherId, "Altrui", await accountModel(otherId, "B"));
    await emitEvent({ instanceId: mine, type: "piano_proposto", bulletin: "Piano pronto" });
    await emitEvent({ instanceId: theirs, type: "bloccato", bulletin: "Segreto altrui" });
    const client = await connect(token);
    const first = await call(client, "bollettino");
    expect(first.json.events).toHaveLength(1);
    expect(first.json.events[0]).toMatchObject({ teamId: mine, type: "piano_proposto", text: "Piano pronto" });
    expect((await call(client, "bollettino")).json.events).toEqual([]);
    const [other] = await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, theirs));
    expect(other!.readAt).toBeNull();
    await client.close();
  });

  it("squadra_dettaglio: PLAN, compiti ed eventi; squadra altrui o inesistente → stesso errore", async () => {
    const mine = await activeTeam(userId, "Mia", modelId);
    const theirs = await activeTeam(otherId, "Altrui", await accountModel(otherId, "B"));
    await writePlanVersion(mine, { objective: "Consegnare", constraints: [], openPoints: [], tasks: [], manualActions: [] }, "proposed");
    await emitEvent({ instanceId: mine, type: "piano_proposto", bulletin: "Piano pronto" });
    const client = await connect(token);
    const ok = await call(client, "squadra_dettaglio", { id: mine });
    expect(ok.isError).toBe(false);
    expect(ok.json).toMatchObject({ id: mine, name: "Mia", plan: { objective: "Consegnare", status: "proposed" }, tasks: [] });
    expect(ok.json.events[0]).toMatchObject({ text: "Piano pronto", read: false });

    const foreign = await call(client, "squadra_dettaglio", { id: theirs });
    const missing = await call(client, "squadra_dettaglio", { id: 99_999 });
    expect(foreign.isError).toBe(true);
    expect(foreign.json).toEqual({ error: "squadra non trovata" });
    expect(missing.json).toEqual(foreign.json);
    await client.close();
  });

  it("invia_al_capo: accoda un turno `request`; squadra altrui → non trovata; 11° messaggio nel minuto → errore (stesso budget della route)", async () => {
    const mine = await activeTeam(userId, "Mia", modelId);
    const theirs = await activeTeam(otherId, "Altrui", await accountModel(otherId, "B"));
    const client = await connect(token);
    const ok = await call(client, "invia_al_capo", { id: mine, testo: "  Come va?  " });
    expect(ok.json).toEqual({ queued: true });
    const [turn] = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, mine));
    expect(turn!.reasons).toContainEqual({ type: "request", text: "Come va?" });

    expect((await call(client, "invia_al_capo", { id: theirs, testo: "ciao" })).json).toEqual({ error: "squadra non trovata" });
    expect((await call(client, "invia_al_capo", { id: mine, testo: "   " })).isError).toBe(true);
    for (let i = 2; i <= 10; i++) expect((await call(client, "invia_al_capo", { id: mine, testo: `m${i}` })).isError).toBe(false);
    const limited = await call(client, "invia_al_capo", { id: mine, testo: "undicesimo" });
    expect(limited.isError).toBe(true);
    expect(limited.json.error).toMatch(/Troppe richieste/);
    await client.close();
  });

  it("coda_da_confermare + approva di un'azione (esegue) e di un piano; voce altrui → non trovata", async () => {
    const team = await activeTeam(userId, "Mia", modelId);
    const action = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args: { id: "42" }, recipient: "Rosa", summary: "Imposta la password" });
    const view = await writePlanVersion(team, { objective: "Obiettivo", constraints: [], openPoints: [], tasks: [], manualActions: [] }, "proposed");
    const planItem = await enqueuePlanItem({ userId, instanceId: team, kind: "plan", planVersion: view.version, recipient: "Mia", summary: "Piano della squadra", detail: { objective: "Obiettivo" } });
    const otherItem = await enqueueAction({ userId: otherId, appId, agentId: null, runId: null, tool, args: { id: "1" }, recipient: "X", summary: "Altrui" });
    if (!action.ok || !planItem.ok || !otherItem.ok) throw new Error("accodamento");

    const client = await connect(token);
    const queue = await call(client, "coda_da_confermare");
    expect(queue.json.actions.map((a: { number: number }) => a.number)).toEqual([action.number, planItem.number]);
    expect(queue.json.actions[0]).toMatchObject({ kind: "action", tool: "set_pw", recipient: "Rosa", needsUserToken: false });
    expect(queue.json.actions[1]).toMatchObject({ kind: "plan", team: { id: team, name: "Mia" } });
    expect(JSON.stringify(queue.json)).not.toContain("Altrui");

    // userToken passato a un tool con identità `service`: ignorato
    const done = await call(client, "approva", { numero: action.number, userToken: "tok-utente" });
    expect(done.isError).toBe(false);
    expect(done.json).toMatchObject({ number: action.number, status: "done" });
    expect(mcpApp.calls).toHaveLength(1);
    expect(JSON.stringify(mcpApp.calls)).not.toContain("tok-utente");

    const approved = await call(client, "approva", { numero: planItem.number });
    expect(approved.json).toMatchObject({ status: "done" });
    expect((await getPlan(team)).status).toBe("approved");

    const again = await call(client, "approva", { numero: action.number });
    expect(again.isError).toBe(true);
    const foreign = await call(client, "approva", { numero: otherItem.number });
    expect(foreign.isError).toBe(true);
    expect((await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.userId, otherId)))[0]!.status).toBe("pending");
    await client.close();
  });

  it("approva di un'azione con identità utente senza userToken → errore con il messaggio dell'API", async () => {
    await db.update(appToolsTable).set({ identity: "user" }).where(eq(appToolsTable.id, tool.id));
    const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool: { ...tool, identity: "user" }, args: { id: "42" }, recipient: "Rosa", summary: "Imposta" });
    if (!out.ok) throw new Error("accodamento");
    const client = await connect(token);
    const queue = await call(client, "coda_da_confermare");
    expect(queue.json.actions[0].needsUserToken).toBe(true);
    const res = await call(client, "approva", { numero: out.number });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBeTruthy();
    expect(mcpApp.calls).toHaveLength(0);
    await client.close();
  });

  it("rifiuta con nota: voce rejected, il turno del capo porta la nota", async () => {
    const team = await activeTeam(userId, "Mia", modelId);
    const view = await writePlanVersion(team, { objective: "O", constraints: [], openPoints: [], tasks: [], manualActions: [] }, "proposed");
    const item = await enqueuePlanItem({ userId, instanceId: team, kind: "plan", planVersion: view.version, recipient: "Mia", summary: "Piano", detail: { objective: "O" } });
    if (!item.ok) throw new Error("accodamento");
    const client = await connect(token);
    const res = await call(client, "rifiuta", { numero: item.number, nota: "manca il budget" });
    expect(res.json).toMatchObject({ number: item.number, status: "rejected" });
    const [turn] = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, team));
    expect(turn!.reasons).toContainEqual({ type: "decision", number: item.number, outcome: "rejected", note: "manca il budget" });
    expect((await call(client, "rifiuta", { numero: 999 })).isError).toBe(true);
    await client.close();
  });

  it("un altro utente non vede né decide le voci del primo", async () => {
    const team = await activeTeam(userId, "Mia", modelId);
    const out = await enqueueAction({ userId, appId, agentId: null, runId: null, tool, args: { id: "1" }, recipient: "R", summary: "S", teamInstanceId: team });
    if (!out.ok) throw new Error("accodamento");
    const client = await connect(otherToken);
    expect((await call(client, "coda_da_confermare")).json.actions).toEqual([]);
    expect((await call(client, "rifiuta", { numero: out.number })).isError).toBe(true);
    expect((await call(client, "squadre_stato")).json.lines).toEqual([]);
    await client.close();
  });
});

describe("limite dei messaggi al capo", () => {
  it("lo strumento e la route condividono lo stesso contatore", () => {
    const uid = 987_654;
    for (let i = 0; i < 10; i++) expect(consumeTeamMessage(uid)).toBe(true);
    expect(consumeTeamMessage(uid)).toBe(false);
    let status = 0;
    const res = { setHeader: () => {}, status: (s: number) => ({ json: () => void (status = s) }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    teamMessageRateLimit({ userId: uid } as any, res as any, () => void (status = 200));
    expect(status).toBe(429);
  });
});
