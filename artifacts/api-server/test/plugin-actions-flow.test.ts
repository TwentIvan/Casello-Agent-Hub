import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  appToolsTable,
  appsTable,
  characterMessagesTable,
  leadConversationsTable,
  planConversationsTable,
  planMessagesTable,
  planProposalsTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { ensureEmbedClients } from "../src/lib/embed/clients";
import { resetPageSeen } from "../src/lib/embed/status";
import { resetEmbedStatusLimits } from "../src/middlewares/rate-limit";
import { startRun } from "../src/lib/run-executor";
import { pageActionsHash } from "../src/lib/apps/page-actions";
import { encryptSecret } from "../src/lib/secrets";
import { allowTestLoopback, startFakeProvider, type FakeProvider } from "./fake-provider";

// Prova di flusso del riordino del plugin: pannello incorporato collegato → stato con le azioni della pagina → clic su
// un'azione → run del Responsabile con l'azione nell'input → voce in «Da confermare». Più: scheda `page_actions` di Lucius,
// `host.app` verificato sul messaggio di Alfred, conversazione senza App irraggiungibile dal pannello.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "EMBED_ALLOWED_ORIGINS"] as const;
const HUB = "https://hubup.example";
const PUBLIC = "https://casello.example.test";
const saved: Record<string, string | undefined> = {};
const TASK_ACTIONS = [
  { page: "task", label: "Esegui il task", request: "Leggi GET /api/tasks/:id/abap-execution e dimmi se si può eseguire" },
  { page: "task", label: "Riassumi il task", request: "Riassumi il task aperto" },
];
const HOST_PAGE = { page: "host", host: { app: "thu", page: "task", id: "7", title: "Importa i clienti" } };

let base: string;
let server: http.Server;
let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let modelId: number;
let thuId: number;
let thuLeadId: number;
let caselloLeadId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    AUTH_DISABLED: "true",
    ALLOWED_EMAILS: "dev@localhost",
    CASELLO_SECRET_KEY: "e".repeat(64),
    PUBLIC_APP_URL: PUBLIC,
    EMBED_ALLOWED_ORIGINS: HUB,
  });
  restoreLoopback = allowTestLoopback();
  vi.spyOn(console, "log").mockImplementation(() => {});
  fake = await startFakeProvider();
  const { default: app } = await import("../src/app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await fake.close();
  restoreLoopback();
  await pool.query("TRUNCATE oauth_clients, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => {
  fake.requests.length = 0;
});

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  resetPageSeen();
  resetEmbedStatusLimits();
  const [user] = await db.insert(usersTable).values({ email: "dev@localhost", name: "Ivan" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret("k"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake" }).returning();
  modelId = model!.id;
  await db.update(usersTable).set({ alfredChatAiModelId: modelId, luciusAiModelId: modelId }).where(eq(usersTable.id, userId));

  const [casello] = await db.insert(appsTable).values({ name: "Botcave", slug: "casello", baseUrl: "http://casello.example" }).returning();
  const [caselloLead] = await db
    .insert(agentsTable)
    .values({ appId: casello!.id, name: "Responsabile", role: "general", status: "active", aiModelId: modelId })
    .returning();
  caselloLeadId = caselloLead!.id;

  const [thu] = await db.insert(appsTable).values({ name: "The Hub Up", slug: "thu", baseUrl: HUB, pageActions: TASK_ACTIONS }).returning();
  thuId = thu!.id;
  const [lead] = await db
    .insert(agentsTable)
    .values({ appId: thuId, name: "Resp THU", role: "general", status: "active", aiModelId: modelId, model: "fake-model" })
    .returning();
  thuLeadId = lead!.id;
  // Azione con effetti verso terzi: la run non la esegue, la accoda
  await db.insert(appToolsTable).values({
    appId: thuId,
    name: "avvia_task",
    description: "Avvia l'esecuzione di un task",
    kind: "http",
    identity: "service",
    level: "L2",
    status: "active",
    paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    definition: { method: "POST", path: "/tasks/{id}/execute", paramLocations: { id: "path" } },
  });
  await ensureEmbedClients();
});

const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");

/** Token d'accesso del pannello incorporato di HUB (consenso con la sessione di sviluppo), come in test/embed-token.test.ts. */
async function embedToken(): Promise<string> {
  const clientId = `embed:${HUB}`;
  const redirectUri = `${PUBLIC}/embed/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const qs = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "embed",
  }).toString();
  const page = await fetch(`${base}/oauth/authorize?${qs}`, { redirect: "manual" });
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const dec = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ csrf, decision: "allow" }).toString(),
  });
  const code = new URL(dec.headers.get("location")!).searchParams.get("code")!;
  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
  });
  return ((await tok.json()) as { access_token: string }).access_token;
}

describe("plugin: azioni della pagina", () => {
  it("stato con 2 azioni → clic → run del Responsabile con l'azione → voce in «Da confermare»", async () => {
    const t = await embedToken();

    const before = await api("GET", "/embed/status?page=task", undefined, t);
    expect(before.status).toBe(200);
    expect(before.json.actions).toEqual([{ label: "Esegui il task" }, { label: "Riassumi il task" }]);
    expect(before.json.actions).toHaveLength(2);
    expect(before.json).toMatchObject({ pending: 0, leadAvailable: true, leadWorking: false });
    expect(before.json.botNames.lead).toBe("Responsabile");

    const conv = await api("POST", "/lead-conversations", undefined, t);
    expect(conv.status).toBe(201);
    const sent = await api(
      "POST",
      `/lead-conversations/${conv.json.id}/messages`,
      { content: "Esegui il task", pageContext: HOST_PAGE, actionLabel: "Esegui il task" },
      t,
    );
    expect(sent.status).toBe(202);
    const runId = sent.json.runId as number;
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(run).toMatchObject({ status: "pending", agentId: thuLeadId });
    expect(run!.input).toContain("Azione «Esegui il task» scelta dall'utente: Leggi GET /api/tasks/:id/abap-execution");
    expect(run!.input).toContain(`<dati>app thu, pagina task, id 7, "Importa i clienti"</dati>`);

    expect((await api("GET", "/embed/status?page=task", undefined, t)).json.leadWorking).toBe(true);

    // Il Responsabile chiama lo strumento L2, poi risponde: la voce va in coda, la run non esegue nulla
    let calls = 0;
    fake.chatReply = () => {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [
            { id: "c1", name: "avvia_task", arguments: JSON.stringify({ id: "7", destinatario: "The Hub Up", sintesi: "Avvia l'esecuzione del task 7" }) },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
      }
      return { content: "Ho messo in coda l'avvio del task.", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    };
    await startRun(runId);
    const [done] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(done!.status).toBe("succeeded");

    const queue = await api("GET", "/pending-actions", undefined, t);
    expect(queue.status).toBe(200);
    expect(queue.json.actions).toHaveLength(1);
    expect(queue.json.actions[0]).toMatchObject({ number: 1, status: "pending", summary: "Avvia l'esecuzione del task 7", kind: "action", recipient: "The Hub Up" });

    const after = await api("GET", "/embed/status?page=task", undefined, t);
    expect(after.json).toMatchObject({ pending: 1, leadWorking: false });
  });

  it("scheda page_actions di Lucius: capitolo null, accettata, le azioni dell'App cambiano", async () => {
    const [analysis] = await db
      .insert(analysesTable)
      .values({ appId: thuId, model: "m", sources: { code: "none", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
      .returning();
    const [conv] = await db.insert(planConversationsTable).values({ appId: thuId, analysisId: analysis!.id, userId, title: "Azioni" }).returning();
    const [msg] = await db.insert(planMessagesTable).values({ conversationId: conv!.id, role: "assistant", content: "Ecco le azioni" }).returning();
    const [proposal] = await db
      .insert(planProposalsTable)
      .values({
        conversationId: conv!.id,
        messageId: msg!.id,
        kind: "page_actions",
        chapter: null,
        rationale: "Serve un'azione di analisi",
        payload: { page: "task", actions: [{ label: "Analizza il task", request: "Analizza il task aperto" }] },
        targetHash: pageActionsHash(TASK_ACTIONS, "task"),
      })
      .returning();

    const decided = await api("POST", `/plan-proposals/${proposal!.id}/decision`, { action: "accept" });
    expect(decided.status).toBe(200);
    expect(decided.json.item).toBeNull();
    expect(decided.json.proposal).toMatchObject({ kind: "page_actions", chapter: null, status: "accepted" });

    const [app] = await db.select({ a: appsTable.pageActions }).from(appsTable).where(eq(appsTable.id, thuId));
    expect(app!.a).toEqual([{ page: "task", label: "Analizza il task", request: "Analizza il task aperto" }]);
  });

  it("messaggio di Alfred dal pannello: host.app è sempre l'App ospite del token", async () => {
    const t = await embedToken();
    const thread = await api("GET", "/characters/alfred/thread", undefined, t);
    expect(thread.status).toBe(200);
    const id = thread.json.id as number;
    // La pagina ospite dichiara un'altra App: il server la sovrascrive con lo slug dell'App del client
    const forged = { page: "host", host: { app: "casello", page: "task", id: "7", title: "T" } };
    const sent = await api("POST", `/character-conversations/${id}/messages`, { content: "Ciao", pageContext: forged }, t);
    expect(sent.status).toBe(202);
    expect(sent.json.pageContext.host.app).toBe("thu");

    const [row] = await db.select().from(characterMessagesTable).where(eq(characterMessagesTable.id, sent.json.id));
    expect((row!.pageContext as { host: { app: string } }).host.app).toBe("thu");

    // Il turno gira in background con il finto provider: si aspetta che finisca prima di chiudere il test
    for (let i = 0; i < 100; i++) {
      const d = await api("GET", `/character-conversations/${id}`, undefined, t);
      if (d.json?.turnStatus === "idle") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it("conversazione del Responsabile senza App: irraggiungibile dal pannello (404)", async () => {
    const t = await embedToken();
    const [legacy] = await db.insert(leadConversationsTable).values({ userId, agentId: caselloLeadId, title: "vecchia" }).returning();
    expect(legacy!.appId).toBeNull();
    expect((await api("GET", `/lead-conversations/${legacy!.id}`, undefined, t)).status).toBe(404);
    expect((await api("POST", `/lead-conversations/${legacy!.id}/messages`, { content: "x" }, t)).status).toBe(404);
    expect((await api("DELETE", `/lead-conversations/${legacy!.id}`, undefined, t)).status).toBe(404);
    expect((await api("GET", "/lead-conversations", undefined, t)).json).toEqual([]);
    // La sessione la vede ancora come conversazione di casello
    expect((await api("GET", `/lead-conversations/${legacy!.id}`)).status).toBe(200);
  });
});
