// Server MCP di Casello su /mcp: espone agli agenti locali (Claude Code sul Mac dell'utente) il ciclo
// di vita delle analisi dell'architetto eseguite in locale. Streamable HTTP in modalità stateless: un
// server e un trasporto per ogni POST, nessuna sessione. Autenticazione con il token personale,
// rate limit per utente.
//
// Gli argomenti degli strumenti sono dati non attendibili: li valida Zod (qui e nell'esecutore) e
// nei log finiscono solo id, nomi di strumento e di fase. Ogni risultato è un unico testo JSON; gli
// errori dell'esecutore tornano con `isError` e il solo messaggio fisso. Nessun segreto (token
// GitHub, chiavi, token personali) esce dagli strumenti.

import type { IncomingMessage } from "node:http";
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger";
import { rateLimit } from "../../middlewares/rate-limit";
import {
  LOCAL_LEASE_MS,
  LocalAnalysisError,
  abandonLocalAnalysis,
  claimLocalAnalysis,
  listOpenLocalAnalyses,
  localOpenApi,
  localPhaseInstructions,
  pingLocalAnalysis,
  submitLocalPhase,
  type LocalSourceOptions,
} from "../architect/local-executor";
import { FULL_READ_LIMITS, capOutput, listOperations } from "../architect/phase-loop";
import { PHASES } from "../architect/schemas";
import { describeOperation } from "../architect/sources";
import { requireApiToken } from "./auth";

/** Chiamate al minuto per utente (spec §9). */
export const MCP_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;
/** Corpo massimo di una richiesta MCP (un esito di fase), come `client_max_body_size` di nginx. */
const MCP_BODY_LIMIT = "2mb";

const SERVER_INFO = { name: "casello", version: "1.0.0" } as const;

export interface McpRouterOptions {
  /** Solo per i test: limite diverso da 60 al minuto. */
  rateLimit?: { limit: number; windowMs: number };
  /** Solo per i test: GitHub e fetch dell'OpenAPI. */
  sources?: LocalSourceOptions;
}

// --- Risultati ----------------------------------------------------------------------------------

function jsonResult(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/** Esegue lo strumento: errori dell'esecutore → messaggio fisso; altri errori → messaggio generico. */
async function run(tool: string, fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (err) {
    if (err instanceof LocalAnalysisError) return jsonResult({ error: err.message }, true);
    logger.error({ tool, errName: err instanceof Error ? err.name : "unknown" }, "Strumento MCP non riuscito");
    return jsonResult({ error: "errore interno, riprova più tardi" }, true);
  }
}

// --- Schemi degli argomenti ---------------------------------------------------------------------

const analysisId = z.number().int().positive().describe("Id dell'analisi (da list_analyses)");
const leaseToken = z.string().min(1).max(200).describe("Token della lease restituito da claim_analysis");

/**
 * L'esito arriva di solito come oggetto; alcuni client lo serializzano in una stringa JSON: in quel
 * caso si decodifica (solo come dato, poi lo valida lo schema della fase).
 */
function decodeResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// --- Server -------------------------------------------------------------------------------------

/** Server MCP con i sette strumenti dell'agente locale. */
export function createMcpServer(sources: LocalSourceOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_analyses",
    {
      description:
        "Elenca le analisi dell'architetto di Casello da eseguire in locale (in coda o in corso): id, app, fase corrente, fasi già consegnate e lease (chi la tiene e fino a quando).",
      inputSchema: {},
    },
    () =>
      run("list_analyses", async () => ({
        analyses: (await listOpenLocalAnalyses()).map((a) => ({
          ...a,
          leaseUntil: a.leaseUntil ? a.leaseUntil.toISOString() : null,
        })),
      })),
  );

  server.registerTool(
    "claim_analysis",
    {
      description: `Prende in carico un'analisi (in coda o con la lease scaduta) e restituisce il token della lease, la fase da eseguire, la scheda dell'app (repository GitHub e branch, OpenAPI disponibile sì/no) e il commit atteso del branch (null se ignoto). La lease dura ${LOCAL_LEASE_MS / 60_000} minuti e si rinnova a ogni consegna e con ping_analysis.`,
      inputSchema: {
        analysisId,
        label: z.string().describe("Nome di questa postazione, mostrato in console (es. \"Mac di Ivan\"), al massimo 100 caratteri"),
      },
    },
    ({ analysisId: id, label }) =>
      run("claim_analysis", async () => {
        const claim = await claimLocalAnalysis(id, label, new Date(), sources);
        return {
          analysisId: id,
          leaseToken: claim.leaseToken,
          phase: claim.phase,
          app: claim.app,
          expectedCommit: claim.expectedCommit,
        };
      }),
  );

  server.registerTool(
    "get_phase_instructions",
    {
      description:
        "Istruzioni della fase corrente: `system` e `user` sono il prompt da seguire, con l'esempio JSON dell'esito e gli appunti delle fasi precedenti. Esegui la fase sul clone locale e consegna con submit_phase.",
      inputSchema: { analysisId, leaseToken },
    },
    ({ analysisId: id, leaseToken: lease }) => run("get_phase_instructions", () => localPhaseInstructions(id, lease, new Date(), sources)),
  );

  server.registerTool(
    "read_openapi",
    {
      description:
        "Legge il contratto OpenAPI dell'app (può non stare nel clone). Con `method` e `path` descrive un'operazione (parametri, corpo, risposte); altrimenti elenca le operazioni, filtrabili per prefisso del percorso e paginabili con offset.",
      inputSchema: {
        analysisId,
        leaseToken,
        prefix: z.string().max(500).optional().describe("Solo le operazioni il cui percorso inizia così (es. /api/teams)"),
        offset: z.number().int().min(0).optional().describe("Salta le prime N operazioni dell'elenco"),
        method: z.string().max(10).optional().describe("Metodo HTTP dell'operazione da descrivere (con path)"),
        path: z.string().max(2000).optional().describe("Percorso dell'operazione da descrivere, come nell'elenco (con method)"),
      },
    },
    ({ analysisId: id, leaseToken: lease, prefix, offset, method, path }) =>
      run("read_openapi", async () => {
        const doc = await localOpenApi(id, lease, new Date(), sources);
        if (!doc) return { hasOpenApi: false, content: "L'app non espone un contratto OpenAPI raggiungibile." };
        const content =
          method && path
            ? capOutput(describeOperation(doc, method.toUpperCase(), path), FULL_READ_LIMITS)
            : listOperations(doc, prefix, offset, FULL_READ_LIMITS).content;
        return { hasOpenApi: true, content };
      }),
  );

  server.registerTool(
    "submit_phase",
    {
      description:
        "Consegna l'esito della fase corrente (oggetto JSON nella forma dell'esempio delle istruzioni). Se l'esito non è valido torna `ok: false` con le issues da correggere: correggi e consegna di nuovo. Indica in sourceCommit lo sha del commit analizzato.",
      inputSchema: {
        analysisId,
        leaseToken,
        phase: z.enum(PHASES).describe("Fase che stai consegnando: deve essere quella corrente"),
        result: z.unknown().describe("Esito della fase, nella forma dell'esempio delle istruzioni"),
        sourceCommit: z.string().max(64).optional().describe("Sha del commit del clone analizzato (git rev-parse HEAD)"),
      },
    },
    ({ analysisId: id, leaseToken: lease, phase, result, sourceCommit }) =>
      run("submit_phase", async () => {
        const outcome = await submitLocalPhase(id, lease, phase, decodeResult(result), sourceCommit);
        if (!outcome.ok) return { ok: false, error: "esito non valido", issues: outcome.issues };
        return outcome;
      }),
  );

  server.registerTool(
    "ping_analysis",
    {
      description: `Rinnova la lease (${LOCAL_LEASE_MS / 60_000} minuti) mentre lavori a lungo su una fase.`,
      inputSchema: { analysisId, leaseToken },
    },
    ({ analysisId: id, leaseToken: lease }) =>
      run("ping_analysis", async () => {
        const { leaseUntil } = await pingLocalAnalysis(id, lease);
        return { leaseUntil: leaseUntil.toISOString() };
      }),
  );

  server.registerTool(
    "abandon_analysis",
    {
      description: "Rinuncia all'analisi: si chiude come fallita con il motivo indicato (mostrato in console).",
      inputSchema: {
        analysisId,
        leaseToken,
        reason: z.string().describe("Motivo della rinuncia, al massimo 300 caratteri"),
      },
    },
    ({ analysisId: id, leaseToken: lease, reason }) =>
      run("abandon_analysis", async () => {
        await abandonLocalAnalysis(id, lease, reason);
        return { ok: true };
      }),
  );

  return server;
}

// --- Router -------------------------------------------------------------------------------------

/** Corpo illeggibile o troppo grande: errore JSON-RPC, senza ripetere il contenuto. */
const bodyErrorHandler: ErrorRequestHandler = (err: { status?: number; type?: string }, _req, res, _next) => {
  const status = err.status === 413 ? 413 : 400;
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32700, message: status === 413 ? "richiesta troppo grande" : "JSON non valido" },
    id: null,
  });
};

/**
 * Router di /mcp: solo POST (stateless), dopo token e rate limit; ogni altro metodo → 405 (anche
 * OPTIONS: /mcp non è per i browser, nessuna origine CORS ammessa).
 */
export function mcpRouter(opts: McpRouterOptions = {}): Router {
  const router = express.Router();
  const limiter = rateLimit({ ...(opts.rateLimit ?? MCP_RATE_LIMIT), key: (req) => `user:${req.mcpUserId ?? "?"}` });

  const handle: RequestHandler = async (req, res) => {
    const server = createMcpServer(opts.sources);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // Come IncomingMessage: req.auth di Express (token o sessione su /api) non è l'AuthInfo
      // dell'SDK MCP, e /mcp non lo imposta (l'utente è in req.mcpUserId)
      await transport.handleRequest(req as IncomingMessage, res, req.body);
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Richiesta MCP non riuscita");
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "errore interno" }, id: null });
      }
    }
  };

  router.post("/", requireApiToken(), limiter, express.json({ limit: MCP_BODY_LIMIT }), handle, bodyErrorHandler);

  router.all("/", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "metodo non ammesso: usa POST" }, id: null });
  });

  return router;
}
