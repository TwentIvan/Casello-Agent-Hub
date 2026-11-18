import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, agentsTable, leadConversationsTable, runsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createApiToken } from "../lib/api-tokens";
import { encryptSecret } from "../lib/secrets";
import { ensureEmbedClients } from "../lib/embed/clients";

// Route della chat con il Responsabile di Botcave su un'app Express vera senza login (AUTH_DISABLED=true).
// La coda delle run non parte: le run restano `pending`. Il pannello incorporato (token embed di https://hubup.example)
// raggiunge solo il Responsabile dell'App ospite `thu`.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY", "PUBLIC_APP_URL", "EMBED_ALLOWED_ORIGINS"] as const;
const HUB = "https://hubup.example";
const PUBLIC = "https://casello.example.test";
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let userId: number;
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
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  process.env["CASELLO_SECRET_KEY"] = "d".repeat(64);
  process.env["PUBLIC_APP_URL"] = PUBLIC;
  process.env["EMBED_ALLOWED_ORIGINS"] = HUB;
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE oauth_clients, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE oauth_clients, apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "dev@localhost", name: "Ivan" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: "https://llm.example/v1", apiKeyEnc: encryptSecret("k"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "Botcave", slug: "casello", baseUrl: "http://casello.example" }).returning();
  const [lead] = await db
    .insert(agentsTable)
    .values({ appId: app!.id, name: "Responsabile", role: "general", status: "active", aiModelId: model!.id })
    .returning();
  caselloLeadId = lead!.id;
  const [thu] = await db
    .insert(appsTable)
    .values({
      name: "The Hub Up",
      slug: "thu",
      baseUrl: HUB,
      pageActions: [{ page: "task", label: "Esegui il task", request: "Leggi GET /api/tasks/:id/abap-execution e avvia" }],
    })
    .returning();
  await db.insert(agentsTable).values({ appId: thu!.id, name: "Resp THU", role: "general", status: "active", aiModelId: model!.id });
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

const HOST_PAGE = { page: "host", host: { app: "thu", page: "task", id: "7", title: "T" } };

describe("chat con il Responsabile", () => {
  it("disponibilità, conversazione, messaggio, dettaglio, eliminazione", async () => {
    const avail = await api("GET", "/lead-chat");
    expect(avail.status).toBe(200);
    expect(avail.json).toMatchObject({ available: true, agentName: "Responsabile", modelName: "M", leadName: "Barbara", appSlug: "casello" });

    const conv = await api("POST", "/lead-conversations");
    expect(conv.status).toBe(201);
    const id = conv.json.id as number;

    const sent = await api("POST", `/lead-conversations/${id}/messages`, { content: "ciao", pageContext: { page: "run", id: "4" } });
    expect(sent.status).toBe(202);
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, sent.json.runId));
    expect(run!.status).toBe("pending");

    const detail = await api("GET", `/lead-conversations/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.turnStatus).toBe("running");
    expect(detail.json.messages[0]).toMatchObject({ content: "ciao", pageContext: { page: "run", id: "4" }, run: { status: "pending", items: [] } });

    const busy = await api("POST", `/lead-conversations/${id}/messages`, { content: "ancora" });
    expect(busy.status).toBe(409);
    expect(busy.json.error).toBe("Barbara sta già rispondendo");

    const list = await api("GET", "/lead-conversations");
    expect(list.json).toHaveLength(1);
    expect(list.json[0].title).toBe("ciao");

    expect((await api("DELETE", `/lead-conversations/${id}`)).status).toBe(204);
    expect((await api("GET", `/lead-conversations/${id}`)).status).toBe(404);
  });

  it("corpo e parametri non validi: 400", async () => {
    const conv = await api("POST", "/lead-conversations");
    expect((await api("GET", "/lead-conversations/abc")).status).toBe(400);
    expect((await api("POST", `/lead-conversations/${conv.json.id}/messages`, { content: "x", pageContext: { page: "admin" } })).status).toBe(400);
    expect((await api("POST", `/lead-conversations/${conv.json.id}/messages`, {})).status).toBe(400);
    const long = await api("POST", `/lead-conversations/${conv.json.id}/messages`, { content: "x".repeat(4001) });
    expect(long.status).toBe(400);
    expect(long.json.error).toBe("messaggio troppo lungo: al massimo 4000 caratteri");
    const empty = await api("POST", `/lead-conversations/${conv.json.id}/messages`, { content: "" });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe("messaggio vuoto");
  });

  it("non disponibile: GET dice il motivo, POST 409", async () => {
    await db.update(agentsTable).set({ aiModelId: null });
    const avail = await api("GET", "/lead-chat");
    expect(avail.json).toMatchObject({ available: false, reason: "scegli per Barbara un modello di uno dei tuoi account AI" });
    expect((await api("POST", "/lead-conversations")).status).toBe(409);
  });

  it("token personali: agent e runs 403, api:read solo lettura", async () => {
    const agent = (await createApiToken(userId, "agente", 30, ["agent"])).token;
    const runs = (await createApiToken(userId, "run", 30, ["runs"])).token;
    const read = (await createApiToken(userId, "lettura", 30, ["api:read"])).token;
    for (const t of [agent, runs]) {
      expect((await api("GET", "/lead-chat", undefined, t)).status).toBe(403);
      expect((await api("GET", "/lead-conversations", undefined, t)).status).toBe(403);
      const post = await api("POST", "/lead-conversations", undefined, t);
      expect(post.status).toBe(403);
      expect(post.json.error).toBe("il token non ha l'ambito per questa operazione");
    }
    expect((await api("GET", "/lead-conversations", undefined, read)).status).toBe(200);
    expect((await api("POST", "/lead-conversations", undefined, read)).status).toBe(403);
  });

  it("sessione: ?app sceglie l'App, App inesistente 404", async () => {
    expect((await api("GET", "/lead-chat?app=thu")).json).toMatchObject({ available: true, agentName: "Resp THU", leadName: "Responsabile", appSlug: "thu" });
    const missing = await api("GET", "/lead-chat?app=nessuna");
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("App non trovata");
    expect((await api("GET", "/lead-chat?app=NON_VALIDO")).status).toBe(400);
  });

  it("pannello incorporato: solo l'App ospite", async () => {
    const t = await embedToken();
    const avail = await api("GET", "/lead-chat", undefined, t);
    expect(avail.status).toBe(200);
    expect(avail.json).toMatchObject({ available: true, agentName: "Resp THU", appSlug: "thu" });
    expect((await api("GET", "/lead-chat?app=thu", undefined, t)).status).toBe(200);
    const other = await api("GET", "/lead-chat?app=casello", undefined, t);
    expect(other.status).toBe(404);
    expect(other.json.error).toBe("App non trovata");
    expect((await api("GET", "/lead-conversations?app=casello", undefined, t)).status).toBe(404);
    expect((await api("POST", "/lead-conversations?app=casello", undefined, t)).status).toBe(404);
  });

  it("pannello incorporato: azione della pagina nel messaggio", async () => {
    const t = await embedToken();
    const conv = await api("POST", "/lead-conversations", undefined, t);
    expect(conv.status).toBe(201);
    const id = conv.json.id as number;

    const unknown = await api("POST", `/lead-conversations/${id}/messages`, { content: "Inventata", pageContext: HOST_PAGE, actionLabel: "Inventata" }, t);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe("azione non trovata: ricarica il pannello");
    const otherPage = { page: "host", host: { ...HOST_PAGE.host, page: "proposal" } };
    expect((await api("POST", `/lead-conversations/${id}/messages`, { content: "x", pageContext: otherPage, actionLabel: "Esegui il task" }, t)).status).toBe(400);
    expect((await api("POST", `/lead-conversations/${id}/messages`, { content: "x", actionLabel: "Esegui il task" }, t)).status).toBe(400);
    expect(await db.select().from(runsTable)).toHaveLength(0);

    const sent = await api("POST", `/lead-conversations/${id}/messages`, { content: "Esegui il task", pageContext: HOST_PAGE, actionLabel: "Esegui il task" }, t);
    expect(sent.status).toBe(202);
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, sent.json.runId));
    expect(run!.input).toContain("Azione «Esegui il task» scelta dall'utente: Leggi GET");
    expect(run!.input).toContain("Pagina dell'app ospite");
    expect(run!.input).toContain(`<dati>app thu, pagina task, id 7, "T"</dati>`);

    const detail = await api("GET", `/lead-conversations/${id}`, undefined, t);
    expect(detail.status).toBe(200);
    expect(detail.json.messages[0].pageContext).toEqual(HOST_PAGE);
    expect((await api("GET", "/lead-conversations", undefined, t)).json.map((c: { id: number }) => c.id)).toEqual([id]);
    // La sessione senza ?app (casello) non vede la conversazione di thu
    expect((await api("GET", `/lead-conversations/${id}`)).status).toBe(404);
    expect((await api("GET", `/lead-conversations/${id}?app=thu`)).status).toBe(200);
  });

  it("pannello incorporato: una conversazione di casello è 404", async () => {
    const conv = await api("POST", "/lead-conversations");
    const id = conv.json.id as number;
    const t = await embedToken();
    expect((await api("GET", `/lead-conversations/${id}`, undefined, t)).status).toBe(404);
    expect((await api("POST", `/lead-conversations/${id}/messages`, { content: "x" }, t)).status).toBe(404);
    expect((await api("DELETE", `/lead-conversations/${id}`, undefined, t)).status).toBe(404);
    expect((await api("GET", "/lead-conversations", undefined, t)).json).toEqual([]);
  });

  it("una conversazione senza App resta nell'elenco della sessione (casello)", async () => {
    const [legacy] = await db.insert(leadConversationsTable).values({ userId, agentId: caselloLeadId, title: "vecchia" }).returning();
    const list = await api("GET", "/lead-conversations");
    expect(list.json.map((c: { id: number }) => c.id)).toEqual([legacy!.id]);
    expect((await api("GET", `/lead-conversations/${legacy!.id}`)).status).toBe(200);
    expect((await api("GET", "/lead-conversations?app=thu")).json).toEqual([]);
  });
});
