import { Router, type IRouter, type RequestHandler, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { db, localJobsTable, mcpTokensTable } from "@workspace/db";
import { JOB_EXPIRED, jobByToken, touchJob } from "../lib/local/jobs";
import { createMcpServer, type McpCaller } from "../lib/local/mcp-server";
import { hashToken, tokenKind } from "../lib/local/tokens";
import { logger } from "../lib/logger";
import { rateLimit } from "../middlewares/rate-limit";

// Server MCP dell'agente locale (`/api/mcp`), fuori dalla sessione della console: token di lavoro (il runner) o
// token personale (la chat dell'utente). I token di macchina non usano MCP.

const INVALID_TOKEN = "token non valido o revocato";

function callerOf(res: Response): McpCaller {
  return res.locals["mcpCaller"] as McpCaller;
}

/**
 * Token personale non revocato o token di lavoro di un lavoro aperto. Ricerca per hash sugli indici unici: il token
 * in chiaro non si confronta mai con un valore salvato. Il token di un lavoro chiuso o scaduto dice "lavoro scaduto".
 */
const tokenAuth: RequestHandler = async (req, res, next) => {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const kind = tokenKind(token);
  const hash = hashToken(token);
  if (kind === "personal") {
    const [row] = await db
      .update(mcpTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(mcpTokensTable.tokenHash, hash), isNull(mcpTokensTable.revokedAt)))
      .returning({ userId: mcpTokensTable.userId });
    if (row) {
      res.locals["mcpCaller"] = { kind: "personal", userId: row.userId } satisfies McpCaller;
      res.locals["tokenHash"] = hash;
      next();
      return;
    }
  } else if (kind === "job") {
    const job = await jobByToken(token);
    if (job) {
      // Ogni richiesta del lavoro vale come segnale di vita (e rinnova la scadenza del token)
      await touchJob(job.id);
      res.locals["mcpCaller"] = { kind: "job", job } satisfies McpCaller;
      res.locals["tokenHash"] = hash;
      next();
      return;
    }
    const [known] = await db.select({ id: localJobsTable.id }).from(localJobsTable).where(eq(localJobsTable.jobTokenHash, hash)).limit(1);
    if (known) {
      res.status(401).json({ error: JOB_EXPIRED });
      return;
    }
  }
  res.status(401).json({ error: INVALID_TOKEN });
};

// Risposta JSON-RPC per gli errori del trasporto
function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function createMcpRouter(): IRouter {
  const router: IRouter = Router();

  router.use(tokenAuth);
  // 300 richieste al minuto per token
  router.use(rateLimit({ limit: 300, windowMs: 60_000, key: (_req, res) => `mcp:${res.locals["tokenHash"] as string}` }));

  // Senza stato: un server e un trasporto per richiesta, chiusi alla fine della risposta. Il corpo è già letto da
  // express.json e passa così al trasporto.
  router.post("/", async (req, res) => {
    const server = createMcpServer(callerOf(res));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "richiesta MCP fallita");
      if (!res.headersSent) rpcError(res, 500, "errore interno");
    }
  });

  // Nessuna sessione: niente flusso di notifiche (GET) né chiusura di sessione (DELETE)
  router.get("/", (_req, res) => rpcError(res, 405, "metodo non consentito"));
  router.delete("/", (_req, res) => rpcError(res, 405, "metodo non consentito"));

  return router;
}
