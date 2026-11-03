import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpLowServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// Server MCP finto per i test del client: Streamable HTTP stateless su una porta locale libera.

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  /** Testo restituito da tools/call */
  text?: string;
  structuredContent?: Record<string, unknown>;
  /** Blocchi di contenuto grezzi (es. un'immagine), dopo il testo */
  extraContent?: Record<string, unknown>[];
  isError?: boolean;
  delayMs?: number;
  /** Se presente, il testo restituito è una stringa di questa lunghezza */
  responseBytes?: number;
}

export interface FakeMcp {
  url: string;
  calls: { name: string; args: unknown; headers: Record<string, string> }[];
  setTools(tools: FakeTool[]): void;
  close(): Promise<void>;
}

export async function startFakeMcp(opts: {
  tools: FakeTool[];
  requireAuth?: { header: string; value: string };
}): Promise<FakeMcp> {
  let tools = opts.tools;
  const calls: FakeMcp["calls"] = [];

  const httpServer: Server = createServer((req, res) => {
    if (opts.requireAuth && req.headers[opts.requireAuth.header.toLowerCase()] !== opts.requireAuth.value) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "non autorizzato" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const server = new McpLowServer({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: tools.map((t) => ({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: { type: "object" as const, ...(t.inputSchema ?? { properties: {} }) },
            ...(t._meta ? { _meta: t._meta } : {}),
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(extra.requestInfo?.headers ?? {})) {
            if (typeof v === "string") headers[k] = v;
          }
          calls.push({ name: request.params.name, args: request.params.arguments, headers });
          const tool = tools.find((t) => t.name === request.params.name);
          if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
          if (tool.delayMs) await new Promise((r) => setTimeout(r, tool.delayMs));
          const text = tool.responseBytes ? "x".repeat(tool.responseBytes) : tool.text;
          return {
            content: [...(text !== undefined ? [{ type: "text" as const, text }] : []), ...(tool.extraContent ?? [])],
            ...(tool.structuredContent ? { structuredContent: tool.structuredContent } : {}),
            ...(tool.isError ? { isError: true } : {}),
          };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req as IncomingMessage, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      })();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  return {
    url,
    calls,
    setTools(t) {
      tools = t;
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}
