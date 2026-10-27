import express, { Router, type IRouter, type RequestHandler, type Response } from "express";
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

// Autenticazioni fallite per IP (finestra fissa): oltre il limite ogni richiesta da quell'IP riceve 429 fino allo
// scadere della finestra, prima di qualsiasi lettura del DB
const AUTH_FAILURE_LIMIT = 30;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

/** Azzera i contatori delle autenticazioni fallite (per i test). */
export function resetMcpAuthFailures(): void {
  authFailures.clear();
}

/** Millisecondi di blocco rimasti per l'IP, 0 se non è bloccato. */
function authBlockedFor(ip: string, now: number): number {
  const entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count >= AUTH_FAILURE_LIMIT ? entry.resetAt - now : 0;
}

function recordAuthFailure(ip: string, now: number): void {
  // Pulizia delle finestre scadute, così la mappa non cresce senza limite
  if (authFailures.size > 1000) {
    for (const [key, entry] of authFailures) if (entry.resetAt <= now) authFailures.delete(key);
  }
  let entry = authFailures.get(ip);
  if (!entry || entry.resetAt <= now) authFailures.set(ip, (entry = { count: 0, resetAt: now + AUTH_FAILURE_WINDOW_MS }));
  entry.count++;
}

function callerOf(res: Response): McpCaller {
  return res.locals["mcpCaller"] as McpCaller;
}

/**
 * Token personale non revocato o token di lavoro di un lavoro aperto. Ricerca per hash sugli indici unici: il token
 * in chiaro non si confronta mai con un valore salvato. Il token di un lavoro chiuso o scaduto dice "lavoro scaduto".
 */
const tokenAuth: RequestHandler = async (req, res, next) => {
  const ip = req.ip ?? "unknown";
  const blocked = authBlockedFor(ip, Date.now());
  if (blocked > 0) {
    res.setHeader("Retry-After", Math.ceil(blocked / 1000));
    res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
    return;
  }
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const kind = tokenKind(token);
  const hash = hashToken(token);
  if (kind === "personal") {
    const [row] = await db
      .select({ id: mcpTokensTable.id, userId: mcpTokensTable.userId, lastUsedAt: mcpTokensTable.lastUsedAt })
      .from(mcpTokensTable)
      .where(and(eq(mcpTokensTable.tokenHash, hash), isNull(mcpTokensTable.revokedAt)))
      .limit(1);
    if (row) {
      // Ultimo uso aggiornato al più una volta al minuto: non una scrittura per ogni chiamata
      const now = Date.now();
      if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
        await db.update(mcpTokensTable).set({ lastUsedAt: new Date(now) }).where(eq(mcpTokensTable.id, row.id));
      }
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
    // Un token vero di un lavoro finito non è un tentativo a vuoto: non conta per il limite dei fallimenti
    if (known) {
      res.status(401).json({ error: JOB_EXPIRED });
      return;
    }
  }
  recordAuthFailure(ip, Date.now());
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

  // Senza stato: un server e un trasporto per richiesta, chiusi alla fine della risposta. Il corpo si legge qui,
  // dopo l'autenticazione, con un limite più alto di quello globale (le consegne delle fasi dell'architetto
  // possono essere grandi; il parser globale salta /api/mcp) e passa già letto al trasporto.
  router.post("/", express.json({ limit: "2mb" }), async (req, res) => {
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
      // Solo il nome dell'errore: il messaggio può contenere dati della richiesta
      logger.error({ errName: err instanceof Error ? err.name : typeof err }, "richiesta MCP fallita");
      if (!res.headersSent) rpcError(res, 500, "errore interno");
    }
  });

  // Nessuna sessione: niente flusso di notifiche (GET) né chiusura di sessione (DELETE)
  router.get("/", (_req, res) => rpcError(res, 405, "metodo non consentito"));
  router.delete("/", (_req, res) => rpcError(res, 405, "metodo non consentito"));

  return router;
}
