import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../secrets";
import { startFakeMcp, type FakeMcp, type FakeTool } from "../../../test/fake-mcp";
import { executeTool } from "./executor";
import {
  McpError,
  MCP_MESSAGES,
  callMcpTool,
  listMcpTools,
  mcpAuthHeaders,
  resolveMcpEndpoint,
} from "./mcp-client";
import type { AppConnection, CatalogTool } from "./types";

const VALID_KEY = "0123456789abcdef".repeat(4);
const SERVICE_SECRET = "segreto-di-servizio";
process.env["CASELLO_SECRET_KEY"] = VALID_KEY;

let fake: FakeMcp | null = null;
afterEach(async () => {
  await fake?.close();
  fake = null;
});

function conn(overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    baseUrl: "https://app.example.com",
    internalBaseUrl: null,
    userAuth: { header: "Authorization", scheme: "Bearer" },
    serviceAuth: { header: "X-Service-Key", scheme: null },
    serviceSecretEnc: encryptSecret(SERVICE_SECRET),
    mcpUrl: fake?.url ?? null,
    ...overrides,
  };
}

function mcpTool(name: string, identity: "user" | "service" = "service"): CatalogTool {
  return {
    id: 1,
    appId: 1,
    name,
    description: null,
    kind: "mcp",
    identity,
    level: "L1",
    levelOverride: null,
    status: "active",
    paramsSchema: { type: "object", properties: { q: { type: "string" } } },
    definition: { mcpName: name },
    evidence: null,
    needsVerification: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as CatalogTool;
}

describe("resolveMcpEndpoint", () => {
  it("usa l'origine interna con il path di mcpUrl", () => {
    const url = resolveMcpEndpoint(conn({ internalBaseUrl: "http://svc:5000", mcpUrl: "https://x.it/mcp" }));
    expect(url?.toString()).toBe("http://svc:5000/mcp");
  });
  it("senza mcpUrl è null", () => {
    expect(resolveMcpEndpoint(conn({ mcpUrl: null }))).toBeNull();
  });
  it("senza internalBaseUrl usa mcpUrl", () => {
    expect(resolveMcpEndpoint(conn({ mcpUrl: "https://x.it/mcp" }))?.toString()).toBe("https://x.it/mcp");
  });
});

describe("mcpAuthHeaders", () => {
  it("servizio: header e scheme della configurazione", () => {
    const a = mcpAuthHeaders(conn({ serviceAuth: { header: "Authorization", scheme: "Bearer" } }), "service");
    expect(a.headers).toEqual({ Authorization: `Bearer ${SERVICE_SECRET}` });
    expect(a.secrets).toContain(SERVICE_SECRET);
  });
  it("utente: il token dell'utente", () => {
    expect(mcpAuthHeaders(conn(), "user", "tok-utente").headers).toEqual({ Authorization: "Bearer tok-utente" });
  });
});

describe("listMcpTools", () => {
  it("legge nomi, schemi e livelli", async () => {
    fake = await startFakeMcp({
      tools: [
        { name: "a", description: "Prima", inputSchema: { properties: { q: { type: "string" } } }, _meta: { "casello/level": "L1" } },
        { name: "b", annotations: { readOnlyHint: true } },
        { name: "c" },
      ],
    });
    const tools = await listMcpTools(conn());
    expect(tools.map((t) => [t.name, t.level, t.description])).toEqual([
      ["a", "L1", "Prima"],
      ["b", "L0", null],
      ["c", "L2", null],
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object", properties: { q: { type: "string" } } });
  });

  it("oscura la credenziale rimandata in descrizione e schema", async () => {
    fake = await startFakeMcp({
      tools: [
        {
          name: "a",
          description: `usa ${SERVICE_SECRET}`,
          inputSchema: { properties: { q: { type: "string", description: `chiave ${SERVICE_SECRET}` } } },
        },
      ],
    });
    const [t] = await listMcpTools(conn());
    expect(t?.description).toBe("usa ***");
    expect(JSON.stringify(t?.inputSchema)).not.toContain(SERVICE_SECRET);
    expect(JSON.stringify(t?.inputSchema)).toContain("chiave ***");
  });

  it("non apre il flusso SSE (nessuna GET verso il server)", async () => {
    const methods: string[] = [];
    const real = fetch;
    fake = await startFakeMcp({ tools: [{ name: "a" }] });
    const spy = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return real(input, init);
    }) as typeof fetch;
    await listMcpTools(conn(), { fetchImpl: spy });
    expect(methods.length).toBeGreaterThan(0);
    expect(methods).not.toContain("GET");
  });

  it("più di 500 strumenti: risposta non valida", async () => {
    const many: FakeTool[] = Array.from({ length: 501 }, (_, i) => ({ name: `t${i}` }));
    fake = await startFakeMcp({ tools: many });
    await expect(listMcpTools(conn())).rejects.toMatchObject({ message: MCP_MESSAGES.invalid });
  });

  it("credenziale errata: autenticazione rifiutata", async () => {
    fake = await startFakeMcp({ tools: [{ name: "a" }], requireAuth: { header: "x-service-key", value: "altro" } });
    const err = await listMcpTools(conn()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as Error).message).toBe(MCP_MESSAGES.auth);
  });

  it("usa l'identità di servizio quando c'è il segreto", async () => {
    fake = await startFakeMcp({ tools: [{ name: "a" }], requireAuth: { header: "x-service-key", value: SERVICE_SECRET } });
    expect(await listMcpTools(conn())).toHaveLength(1);
  });

  it("porta chiusa: server non raggiungibile", async () => {
    await expect(listMcpTools(conn({ mcpUrl: "http://127.0.0.1:1/mcp" }))).rejects.toMatchObject({
      message: MCP_MESSAGES.unreachable,
    });
  });

  it("redirect: server non raggiungibile", async () => {
    const srv: Server = createServer((_req, res) => {
      res.writeHead(302, { location: "http://evil.example/" }).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      await expect(listMcpTools(conn({ mcpUrl: `http://127.0.0.1:${port}/mcp` }))).rejects.toMatchObject({
        message: MCP_MESSAGES.unreachable,
      });
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("callMcpTool", () => {
  it("identità service: manda l'header di servizio", async () => {
    fake = await startFakeMcp({ tools: [{ name: "ping", text: "pong" }] });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("ping"), args: { q: "x" } });
    expect(res).toEqual({ ok: true, content: "pong" });
    expect(fake.calls[0]?.args).toEqual({ q: "x" });
    expect(fake.calls[0]?.headers["x-service-key"]).toBe(SERVICE_SECRET);
  });

  it("identità user: manda il token dell'utente", async () => {
    fake = await startFakeMcp({ tools: [{ name: "ping", text: "pong" }] });
    await callMcpTool({ conn: conn(), tool: mcpTool("ping", "user"), args: {}, userToken: "tok-utente" });
    expect(fake.calls[0]?.headers["authorization"]).toBe("Bearer tok-utente");
  });

  it("testo e structuredContent concatenati; immagine omessa", async () => {
    fake = await startFakeMcp({
      tools: [
        {
          name: "mix",
          text: "ciao",
          structuredContent: { n: 1 },
          extraContent: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        },
      ],
    });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("mix"), args: {} });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('ciao\n[contenuto image omesso]\n{"n":1}');
  });

  it("isError: ok false", async () => {
    fake = await startFakeMcp({ tools: [{ name: "bad", text: "non si può", isError: true }] });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("bad"), args: {} });
    expect(res).toEqual({ ok: false, content: "non si può" });
  });

  it("risposta di 2 MB: troppo grande", async () => {
    fake = await startFakeMcp({ tools: [{ name: "big", responseBytes: 2 * 1024 * 1024 }] });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("big"), args: {} });
    expect(res).toEqual({ ok: false, content: "risposta troppo grande (oltre 1048576 byte)" });
  });

  it("ritardo oltre il timeout: timeout", async () => {
    fake = await startFakeMcp({ tools: [{ name: "slow", text: "tardi", delayMs: 1500 }] });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("slow"), args: {}, timeoutMs: 400 });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/^timeout: /);
  });

  it("il segreto rimandato nel testo diventa ***", async () => {
    fake = await startFakeMcp({ tools: [{ name: "echo", text: `chiave ${SERVICE_SECRET} ok` }] });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("echo"), args: {} });
    expect(res.content).toBe("chiave *** ok");
  });

  it("il segreto con virgolette in structuredContent diventa ***", async () => {
    const secret = 'se"gre\\to';
    fake = await startFakeMcp({ tools: [{ name: "echo", structuredContent: { k: `x ${secret} y` } }] });
    const res = await callMcpTool({
      conn: conn({ serviceSecretEnc: encryptSecret(secret) }),
      tool: mcpTool("echo"),
      args: {},
    });
    expect(res.content).toBe('{"k":"x *** y"}');
  });

  it("strumento sconosciuto: non trovato", async () => {
    fake = await startFakeMcp({ tools: [{ name: "a" }] });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("zzz"), args: {} });
    expect(res).toEqual({ ok: false, content: MCP_MESSAGES.notFound });
  });

  it("401: autenticazione rifiutata", async () => {
    fake = await startFakeMcp({ tools: [{ name: "a" }], requireAuth: { header: "x-service-key", value: "altro" } });
    const res = await callMcpTool({ conn: conn(), tool: mcpTool("a"), args: {} });
    expect(res).toEqual({ ok: false, content: MCP_MESSAGES.auth });
  });

  it("porta chiusa: non raggiungibile", async () => {
    const res = await callMcpTool({ conn: conn({ mcpUrl: "http://127.0.0.1:1/mcp" }), tool: mcpTool("a"), args: {} });
    expect(res).toEqual({ ok: false, content: MCP_MESSAGES.unreachable });
  });
});

describe("executeTool con kind mcp", () => {
  it("valida gli argomenti e instrada su MCP", async () => {
    fake = await startFakeMcp({ tools: [{ name: "ping", text: "pong" }] });
    const bad = await executeTool({ conn: conn(), tool: mcpTool("ping"), args: { q: 5 } });
    expect(bad.ok).toBe(false);
    expect(bad.content).toMatch(/^argomenti non validi/);
    const ok = await executeTool({ conn: conn(), tool: mcpTool("ping"), args: { q: "x" } });
    expect(ok).toEqual({ ok: true, content: "pong" });
  });
});
