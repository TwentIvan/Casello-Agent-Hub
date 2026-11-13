import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, aiAccountsTable, aiModelsTable, appsTable, agentsTable, runsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createApiToken } from "../lib/api-tokens";
import { encryptSecret } from "../lib/secrets";

// Route della chat con il Responsabile di Botcave su un'app Express vera senza login (AUTH_DISABLED=true).
// La coda delle run non parte: le run restano `pending`.

const ENV_KEYS = ["AUTH_DISABLED", "ALLOWED_EMAILS", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let base: string;
let server: http.Server;
let userId: number;

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
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { default: app } = await import("../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  const [user] = await db.insert(usersTable).values({ email: "dev@localhost", name: "Ivan" }).returning();
  userId = user!.id;
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: "https://llm.example/v1", apiKeyEnc: encryptSecret("k"), status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "M" }).returning();
  const [app] = await db.insert(appsTable).values({ name: "Botcave", slug: "casello", baseUrl: "http://casello.example" }).returning();
  await db.insert(agentsTable).values({ appId: app!.id, name: "Responsabile", role: "general", status: "active", aiModelId: model!.id });
});

describe("chat con il Responsabile", () => {
  it("disponibilità, conversazione, messaggio, dettaglio, eliminazione", async () => {
    const avail = await api("GET", "/lead-chat");
    expect(avail.status).toBe(200);
    expect(avail.json).toMatchObject({ available: true, agentName: "Responsabile", modelName: "M" });

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
    expect(busy.json.error).toBe("il Responsabile sta già rispondendo");

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
    expect(avail.json).toMatchObject({ available: false, reason: "scegli per il Responsabile un modello di uno dei tuoi account AI" });
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
});
