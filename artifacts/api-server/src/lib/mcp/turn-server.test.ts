import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pool } from "@workspace/db";
import { queueSample, seedNodeTurnSetup, type NodeTurnSetup } from "../../../test/node-turn-fixture";
import { createApiToken } from "../api-tokens";
import type { ChatToolCall } from "../ai/chat-types";
import { claimTurn, reportTurn } from "../node-turns/protocol";
import { registerTurn, unregisterTurn } from "../node-turns/registry";
import { mcpRouter } from "./server";
import { mcpTurnRouter, type McpTurnRouterOptions } from "./turn-server";

// Server MCP del turno: app Express vera con il client MCP dell'SDK; turno `running` ottenuto con claimTurn.

const TOOLS = [
  {
    type: "function" as const,
    function: { name: "leggi_x", description: "Legge x", parameters: { type: "object", properties: { a: { type: "number" } } } },
  },
  { type: "function" as const, function: { name: "rompi", description: "Fallisce sempre", parameters: { type: "object", properties: {} } } },
];

const servers: http.Server[] = [];
let setup: NodeTurnSetup;
let turnId: number;
let turnToken: string;
let leaseToken: string;
let calls: ChatToolCall[];

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function start(opts: McpTurnRouterOptions = {}): Promise<string> {
  const app = express();
  app.use("/mcp/turn", mcpTurnRouter(opts));
  app.use("/mcp", mcpRouter());
  return await listen(http.createServer(app));
}

async function connect(url: string, bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

async function rawPost(url: string, bearer: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (bearer !== null) headers["authorization"] = `Bearer ${bearer}`;
  return fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
}

const textOf = (res: unknown) => ((res as { content: Array<{ text: string }> }).content[0]!.text);

beforeEach(async () => {
  await pool.query("TRUNCATE users CASCADE");
  setup = await seedNodeTurnSetup("dev@localhost");
  const queued = await queueSample(setup);
  turnId = queued.turnId;
  turnToken = queued.turnToken;
  const pkg = (await claimTurn(setup.nodeId, 0))!;
  leaseToken = pkg.leaseToken;
  calls = [];
  registerTurn(turnId, {
    tools: TOOLS,
    maxCalls: 28,
    dispatch: async (call) => {
      calls.push(call);
      return call.name === "rompi" ? '{"ok":false,"error":"no"}' : '{"ok":true,"result":1}';
    },
  });
});

afterEach(async () => {
  unregisterTurn(turnId);
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

afterAll(async () => {
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
});

describe("/mcp/turn", () => {
  it("tools/list restituisce gli strumenti registrati", async () => {
    const client = await connect(`${await start()}/mcp/turn`, turnToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).toEqual(
      TOOLS.map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })),
    );
  });

  it("tools/call passa dal dispatcher; ok:false diventa isError", async () => {
    const client = await connect(`${await start()}/mcp/turn`, turnToken);
    const ok = (await client.callTool({ name: "leggi_x", arguments: { a: 1 } })) as { isError?: boolean };
    expect(textOf(ok)).toBe('{"ok":true,"result":1}');
    expect(ok.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "leggi_x", arguments: '{"a":1}' });
    expect(calls[0]!.id).toBeTruthy();

    const ko = (await client.callTool({ name: "rompi", arguments: {} })) as { isError?: boolean };
    expect(ko.isError).toBe(true);
    expect(textOf(ko)).toBe('{"ok":false,"error":"no"}');
  });

  it("strumento non registrato → errore, dispatcher non chiamato", async () => {
    const client = await connect(`${await start()}/mcp/turn`, turnToken);
    const res = (await client.callTool({ name: "boh", arguments: {} })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("strumento sconosciuto: boh");
    expect(calls).toHaveLength(0);
  });

  it("oltre maxCalls → «limite di strumenti del turno raggiunto»", async () => {
    unregisterTurn(turnId);
    registerTurn(turnId, { tools: TOOLS, maxCalls: 2, dispatch: async () => '{"ok":true}' });
    const client = await connect(`${await start()}/mcp/turn`, turnToken);
    await client.callTool({ name: "leggi_x", arguments: {} });
    await client.callTool({ name: "leggi_x", arguments: {} });
    const res = (await client.callTool({ name: "leggi_x", arguments: {} })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("limite di strumenti del turno raggiunto");
  });

  it("401 per token di un turno chiuso, cas_/cao_, senza token e turno senza voce nel registro", async () => {
    const url = `${await start()}/mcp/turn`;
    expect((await rawPost(url, null)).status).toBe(401);
    const cas = await createApiToken(setup.userId, "t", 30, ["mcp"]);
    expect((await rawPost(url, cas.token)).status).toBe(401);
    expect((await rawPost(url, "cao_abc")).status).toBe(401);
    expect((await rawPost(url, turnToken)).status).toBe(200);

    unregisterTurn(turnId);
    expect((await rawPost(url, turnToken)).status).toBe(401);
    registerTurn(turnId, { tools: TOOLS, maxCalls: 1, dispatch: async () => "{}" });
    expect((await rawPost(url, turnToken)).status).toBe(200);

    await reportTurn(setup.nodeId, turnId, { leaseToken, status: "done", content: "ok" });
    expect((await rawPost(url, turnToken)).status).toBe(401);
  });

  it("un cat_ su /mcp è 401", async () => {
    const base = await start();
    expect((await rawPost(`${base}/mcp`, turnToken)).status).toBe(401);
  });

  it("oltre il limite al minuto → 429", async () => {
    const url = `${await start({ rateLimit: { limit: 3, windowMs: 60_000 } })}/mcp/turn`;
    for (let i = 0; i < 3; i++) expect((await rawPost(url, turnToken)).status).toBe(200);
    expect((await rawPost(url, turnToken)).status).toBe(429);
  });
});
