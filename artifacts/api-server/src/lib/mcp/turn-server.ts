// Server MCP del turno su /mcp/turn: Claude Code sul nodo lo usa per chiamare gli strumenti che Botcave offre al
// turno delegato (spec §4). Streamable HTTP stateless come /mcp, ma autenticato solo con il token `cat_…` del turno
// (turno `running` con lease valida) e con strumenti presi dal registro in memoria: schemi JSON già pronti, quindi
// `Server` di basso livello. Nei log solo id del turno, nome dello strumento ed esito: mai argomenti né token.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bearerToken } from "../api-tokens";
import { logger } from "../logger";
import { rateLimit } from "../../middlewares/rate-limit";
import { turnByToken } from "../node-turns/queue";
import { turnEntry, type TurnEntry } from "../node-turns/registry";
import { MCP_UNAUTHORIZED } from "./auth";

/** Chiamate al minuto per turno (spec §4). */
export const TURN_MCP_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;
const TURN_BODY_LIMIT = "2mb";
const SERVER_INFO = { name: "casello-turno", version: "1.0.0" } as const;

export interface McpTurnRouterOptions {
  /** Solo per i test: limite diverso da 60 al minuto. */
  rateLimit?: { limit: number; windowMs: number };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** `true` se il testo è un oggetto JSON con `ok: false`. */
function isFailure(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

function createTurnServer(turnId: number, entry: TurnEntry): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: entry.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      inputSchema: { type: "object" as const, ...((t.function.parameters ?? {}) as Record<string, unknown>) },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    if (!entry.tools.some((t) => t.function.name === name)) return textResult(`strumento sconosciuto: ${name}`, true);
    if (entry.calls >= entry.maxCalls) return textResult("limite di strumenti del turno raggiunto", true);
    entry.calls += 1;
    try {
      const text = await entry.dispatch({ id: randomUUID(), name, arguments: JSON.stringify(req.params.arguments ?? {}) });
      const failed = isFailure(text);
      logger.info({ turnId, tool: name, ok: !failed }, "Strumento del turno chiamato");
      return textResult(text, failed);
    } catch (err) {
      logger.error({ turnId, tool: name, errName: err instanceof Error ? err.name : "unknown" }, "Strumento del turno non riuscito");
      return textResult(JSON.stringify({ ok: false, error: "errore interno, riprova più tardi" }), true);
    }
  });

  return server;
}

const bodyErrorHandler: ErrorRequestHandler = (err: { status?: number }, _req, res, _next) => {
  const status = err.status === 413 ? 413 : 400;
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32700, message: status === 413 ? "richiesta troppo grande" : "JSON non valido" },
    id: null,
  });
};

/** Router di /mcp/turn: solo POST, dopo il token del turno e il rate limit per turno. */
export function mcpTurnRouter(opts: McpTurnRouterOptions = {}): Router {
  const router = express.Router();
  // Contatore per turno: la chiave è l'id del turno autenticato dal middleware precedente
  const limiter = rateLimit({ ...(opts.rateLimit ?? TURN_MCP_RATE_LIMIT), key: (req) => `turn:${String(req.res?.locals["turnId"])}` });

  const unauthorized = (res: Parameters<RequestHandler>[1]) => res.status(401).json({ error: MCP_UNAUTHORIZED });

  const auth: RequestHandler = (req, res, next) => {
    const token = bearerToken(req);
    if (!token || !token.startsWith("cat_")) {
      unauthorized(res);
      return;
    }
    turnByToken(token)
      .then((turn) => {
        const entry = turn ? turnEntry(turn.id) : undefined;
        // Turno chiuso, scaduto o senza voce nel registro (riavvio): come un token non valido
        if (!turn || !entry) {
          unauthorized(res);
          return;
        }
        res.locals["turnId"] = turn.id;
        res.locals["turnEntry"] = entry;
        next();
      })
      .catch((err: unknown) => {
        logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Verifica del token del turno non riuscita");
        res.status(500).json({ error: "errore interno" });
      });
  };

  const handle: RequestHandler = async (req, res) => {
    const server = createTurnServer(res.locals["turnId"] as number, res.locals["turnEntry"] as TurnEntry);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req as IncomingMessage, res, req.body);
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Richiesta MCP del turno non riuscita");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "errore interno" }, id: null });
      }
    }
  };

  router.post("/", auth, limiter, express.json({ limit: TURN_BODY_LIMIT }), handle, bodyErrorHandler);
  router.all("/", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "metodo non ammesso: usa POST" }, id: null });
  });
  return router;
}
