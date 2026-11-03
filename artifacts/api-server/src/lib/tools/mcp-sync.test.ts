import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, appsTable, appToolsTable } from "@workspace/db";
import { encryptSecret } from "../secrets";
import { startFakeMcp, type FakeMcp, type FakeTool } from "../../../test/fake-mcp";
import { listMcpTools } from "./mcp-client";
import { syncMcpTools } from "./mcp-sync";

// Sincronizzazione del catalogo con il server MCP (fake-mcp) e route di aggiornamento, senza login
// (AUTH_DISABLED=true). Le app non hanno proprietario: «altro utente» non esiste, si prova l'app inesistente.

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

let fake: FakeMcp | null = null;
let server: http.Server;
let base: string;

const tool = (name: string, extra: Partial<FakeTool> = {}): FakeTool => ({
  name,
  description: `Strumento ${name}`,
  inputSchema: { type: "object", properties: {} },
  _meta: { "casello/level": "L1" },
  ...extra,
});

async function createApp(mcpUrl: string | null, secret = false): Promise<number> {
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "App",
      slug: `app-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "https://app.example.com",
      mcpUrl,
      serviceAuth: secret ? { header: "X-Service-Key", scheme: null } : null,
      serviceSecretEnc: secret ? encryptSecret("segreto") : null,
    })
    .returning();
  return app!.id;
}

async function sync(appId: number) {
  return syncMcpTools(appId, await listMcpTools({ ...(await connOf(appId)) }));
}

async function connOf(appId: number) {
  const { loadAppConnection } = await import("./catalog");
  return loadAppConnection(appId);
}

const rows = (appId: number) => db.select().from(appToolsTable).where(eq(appToolsTable.appId, appId));
const row = async (appId: number, name: string) =>
  (await db.select().from(appToolsTable).where(and(eq(appToolsTable.appId, appId), eq(appToolsTable.name, name))))[0]!;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "e".repeat(64);
  const { default: app } = await import("../../app");
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  await pool.query("TRUNCATE users, apps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  vi.restoreAllMocks();
});

describe("syncMcpTools", () => {
  it("prima sincronizzazione: tutti nuovi, bozza, identità secondo il segreto di servizio", async () => {
    fake = await startFakeMcp({ tools: [tool("a"), tool("b", { _meta: { "casello/level": "L0" } }), tool("c")] });
    const appId = await createApp(fake.url, true);
    expect(await sync(appId)).toEqual({ added: 3, updated: 0, disabled: 0, unchanged: 0, conflicts: [] });
    const all = await rows(appId);
    expect(all.map((t) => [t.kind, t.status, t.identity])).toEqual(Array(3).fill(["mcp", "draft", "service"]));
    expect(all[0]!.definition).toEqual({ mcpName: "a" });
    expect((await row(appId, "b")).level).toBe("L0");

    fake.setTools([tool("a")]);
    const other = await createApp(fake.url, false);
    await sync(other);
    expect((await rows(other))[0]!.identity).toBe("user");
  });

  it("secondo giro: uno cambiato, uno sparito, uno nuovo", async () => {
    fake = await startFakeMcp({ tools: [tool("a"), tool("b"), tool("c")] });
    const appId = await createApp(fake.url);
    await sync(appId);
    await db.update(appToolsTable).set({ status: "active" }).where(eq(appToolsTable.appId, appId));

    fake.setTools([tool("a"), tool("b", { description: "nuova" }), tool("d")]);
    expect(await sync(appId)).toEqual({ added: 1, updated: 1, disabled: 1, unchanged: 1, conflicts: [] });
    expect((await row(appId, "b")).description).toBe("nuova");
    expect((await row(appId, "b")).status).toBe("active");
    expect((await row(appId, "c")).status).toBe("disabled");
    expect((await row(appId, "d")).status).toBe("draft");

    // Uno sparito che ricompare resta disabilitato; già disabilitato non si ricontano
    fake.setTools([tool("a"), tool("b", { description: "nuova" }), tool("c", { description: "di nuovo" }), tool("d")]);
    expect(await sync(appId)).toEqual({ added: 0, updated: 1, disabled: 0, unchanged: 3, conflicts: [] });
    expect((await row(appId, "c")).status).toBe("disabled");
    expect((await row(appId, "c")).description).toBe("di nuovo");
  });

  it("la deroga resta se non è sotto il nuovo livello, si azzera altrimenti", async () => {
    fake = await startFakeMcp({ tools: [tool("a", { _meta: { "casello/level": "L0" } })] });
    const appId = await createApp(fake.url);
    await sync(appId);
    await db.update(appToolsTable).set({ levelOverride: "L2" }).where(eq(appToolsTable.appId, appId));

    for (const level of ["L1", "L2"]) {
      fake.setTools([tool("a", { _meta: { "casello/level": level } })]);
      await sync(appId);
      expect((await row(appId, "a")).level).toBe(level);
      expect((await row(appId, "a")).levelOverride).toBe("L2");
    }
    fake.setTools([tool("a", { _meta: { "casello/level": "L3" } })]);
    expect((await sync(appId)).updated).toBe(1);
    expect((await row(appId, "a")).level).toBe("L3");
    expect((await row(appId, "a")).levelOverride).toBeNull();
  });

  it("un nome uguale a un tool HTTP finisce in conflicts e il tool HTTP non cambia", async () => {
    fake = await startFakeMcp({ tools: [tool("lista", { description: "da MCP" })] });
    const appId = await createApp(fake.url);
    await db.insert(appToolsTable).values({
      appId,
      name: "lista",
      description: "http",
      kind: "http",
      level: "L1",
      status: "active",
      definition: { method: "GET", path: "/lista" },
    });
    expect(await sync(appId)).toEqual({ added: 0, updated: 0, disabled: 0, unchanged: 0, conflicts: ["lista"] });
    const t = await row(appId, "lista");
    expect([t.kind, t.description, t.status, t.level]).toEqual(["http", "http", "active", "L1"]);
  });
});

describe("POST /api/apps/:id/mcp-tools/refresh", () => {
  const refresh = async (id: number | string) => {
    const res = await fetch(`${base}/api/apps/${id}/mcp-tools/refresh`, { method: "POST" });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  it("200 con il riepilogo", async () => {
    fake = await startFakeMcp({ tools: [tool("a")] });
    const appId = await createApp(fake.url);
    const res = await refresh(appId);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ added: 1, updated: 0, disabled: 0, unchanged: 0, conflicts: [] });
  });

  it("409 senza mcpUrl, 404 se l'app non esiste, 502 con il server spento", async () => {
    expect(await refresh(await createApp(null))).toEqual({
      status: 409,
      json: { error: "l'app non ha un server MCP" },
    });
    expect((await refresh(9999)).status).toBe(404);

    fake = await startFakeMcp({ tools: [] });
    const appId = await createApp(fake.url);
    await fake.close();
    fake = null;
    const res = await refresh(appId);
    expect(res.status).toBe(502);
    expect(res.json).toEqual({ error: "server MCP non raggiungibile" });
  });
});
