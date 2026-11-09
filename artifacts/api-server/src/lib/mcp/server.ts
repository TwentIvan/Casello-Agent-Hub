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
import { LEAD_REQUEST_MAX, askProductLead, listLeadApps, readLeadRun } from "../product-leads";
import { logger } from "../logger";
import { rateLimit } from "../../middlewares/rate-limit";
import {
  LOCAL_LEASE_MS,
  LocalAnalysisError,
  abandonLocalAnalysis,
  claimLocalAnalysis,
  listOpenLocalAnalyses,
  localMcpTools,
  localOpenApi,
  localPhaseInstructions,
  pingLocalAnalysis,
  submitLocalPhase,
  type LocalSourceOptions,
} from "../architect/local-executor";
import { describeMcpTool, listMcpToolsPage } from "../architect/mcp-source";
import { FULL_READ_LIMITS, listOperations } from "../architect/phase-loop";
import { capOutput } from "../architect/text";
import { PHASES } from "../architect/schemas";
import { describeOperation } from "../architect/sources";
import { InstanceError } from "../teams/instances";
import {
  CentralinoError,
  approvePending,
  messageToLead,
  normalizeExclude,
  pendingQueue,
  readBulletin,
  rejectPending,
  teamDetail,
  teamsStatus,
} from "../teams/centralino";
import { PROPOSAL_MESSAGES, PROPOSAL_STEPS_MAX } from "../actions/proposal";
import { TOKEN_MESSAGES, type TokenScope } from "../api-tokens";
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
    if (err instanceof LocalAnalysisError || err instanceof CentralinoError || err instanceof InstanceError) return jsonResult({ error: err.message }, true);
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

/** Server MCP con gli otto strumenti dell'agente locale. */
export function createMcpServer(sources: LocalSourceOptions = {}, userId: number, scopes: readonly TokenScope[] = ["mcp"]): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_analyses",
    {
      description:
        "Elenca le analisi di Lucius, l'architetto di Botcave, da eseguire in locale (in coda o in corso): id, app, fase corrente, fasi già consegnate e lease (chi la tiene e fino a quando).",
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
      description: `Prende in carico un'analisi (in coda o con la lease scaduta) e restituisce il token della lease, la fase da eseguire, la scheda dell'app (repository GitHub e branch, OpenAPI disponibile sì/no, server MCP disponibile sì/no in hasMcp) e il commit atteso del branch (null se ignoto). La lease dura ${LOCAL_LEASE_MS / 60_000} minuti e si rinnova a ogni consegna e con ping_analysis.`,
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
    "read_mcp_tools",
    {
      description:
        "Legge gli strumenti del server MCP dell'app (elenco letto da Botcave al claim). Con `name` descrive uno strumento (livello dichiarato, descrizione, schema dei parametri); altrimenti elenca gli strumenti con il livello, filtrabili per prefisso del nome e paginabili con offset.",
      inputSchema: {
        analysisId,
        leaseToken,
        prefix: z.string().max(500).optional().describe("Solo gli strumenti il cui nome inizia così"),
        offset: z.number().int().min(0).optional().describe("Salta i primi N strumenti dell'elenco"),
        name: z.string().max(200).optional().describe("Nome dello strumento da descrivere, come nell'elenco"),
      },
    },
    ({ analysisId: id, leaseToken: lease, prefix, offset, name }) =>
      run("read_mcp_tools", async () => {
        const tools = await localMcpTools(id, lease);
        if (!tools) return { hasMcp: false, content: "L'app non ha un server MCP raggiungibile." };
        const content = name
          ? capOutput(describeMcpTool(tools, name), FULL_READ_LIMITS)
          : listMcpToolsPage(tools, { prefix, offset }, FULL_READ_LIMITS).content;
        return { hasMcp: true, content };
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

  registerCentralinoTools(server, userId, scopes);

  return server;
}

/**
 * Strumenti del centralino: Claude dell'utente segue le sue squadre e decide la coda delle conferme. Decidere la coda
 * (`approva`, `rifiuta`) vuole anche l'ambito `api:write` del token, come le route HTTP, e ne consuma il limite.
 */
function registerCentralinoTools(server: McpServer, userId: number, scopes: readonly TokenScope[]): void {
  const canDecide = scopes.includes("api:write");
  const scopeError = () => jsonResult({ error: TOKEN_MESSAGES.scope }, true);
  const teamId = z.number().int().positive().describe("Id della squadra (da squadre_stato)");
  const number = z.number().int().positive().describe("Numero della voce in coda (da coda_da_confermare)");

  server.registerTool(
    "squadre_stato",
    {
      description:
        "Stato delle squadre attive dell'utente: una riga per squadra (nome, lavoro, stato del piano, compiti in corso/finiti/bloccati, eventi non letti). Con più di 5 squadre le righe sono un riassunto.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run("squadre_stato", () => teamsStatus(userId)),
  );

  server.registerTool(
    "bollettino",
    {
      description: "Eventi non letti delle squadre dell'utente, dal più recente. Gli eventi restituiti si segnano come letti.",
      inputSchema: {},
    },
    () => run("bollettino", () => readBulletin(userId)),
  );

  server.registerTool(
    "squadra_dettaglio",
    {
      description: "Dettaglio di una squadra: PLAN (obiettivo, vincoli, compiti, azioni manuali, punti aperti), ultimi compiti e ultimi eventi.",
      inputSchema: { id: teamId },
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run("squadra_dettaglio", () => teamDetail(userId, id)),
  );

  server.registerTool(
    "invia_al_capo",
    {
      description: "Scrive al capo di una squadra attiva: parte un turno del capo con la richiesta. Al massimo 10 messaggi al minuto.",
      inputSchema: { id: teamId, testo: z.string().max(4_000).describe("Richiesta per il capo, al massimo 4 000 caratteri") },
    },
    ({ id, testo }) => run("invia_al_capo", () => messageToLead(userId, id, testo)),
  );

  server.registerTool(
    "coda_da_confermare",
    {
      description:
        "Voci in attesa nella coda delle conferme dell'utente: azioni su app, piani, modifiche del piano e proposte con più passi, con destinatario e sintesi. Per le proposte `steps` è il numero di passi e `args` ne riporta titolo, motivo e passi. `needsUserToken` indica se per approvarla serve `userToken`.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run("coda_da_confermare", () => pendingQueue(userId)),
  );

  server.registerTool(
    "elenca_app",
    {
      description: "App con un Responsabile di prodotto che puoi interpellare: slug, nome e una riga di descrizione.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run("elenca_app", () => listLeadApps(userId)),
  );

  server.registerTool(
    "chiedi_al_responsabile",
    {
      description:
        "Passa una richiesta completa al Responsabile di prodotto di un'App e attende fino a 25 secondi l'esito: risposta, errore e voci create in «Da confermare». Le sue scritture restano in coda.",
      inputSchema: {
        richiesta: z.string().min(1).max(LEAD_REQUEST_MAX).describe("La richiesta completa, al massimo 4 000 caratteri"),
        app: z.string().min(1).max(100).optional().describe("Slug o nome dell'App (da elenca_app); se manca vale Botcave"),
      },
    },
    ({ richiesta, app }) => run("chiedi_al_responsabile", () => askProductLead(userId, { richiesta, app })),
  );

  server.registerTool(
    "leggi_run",
    {
      description: "Stato, esito, errore, costo e voci create di una run dell'utente.",
      inputSchema: { id: z.number().int().positive().describe("Id della run") },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      run("leggi_run", async () => {
        const view = await readLeadRun(userId, id);
        if (!view) throw new CentralinoError("run non trovata");
        return view;
      }),
  );

  server.registerTool(
    "approva",
    {
      description:
        "Approva una voce della coda (un'azione la esegue subito, un piano lo approva, una proposta ne esegue i passi in ordine). `userToken` è il token dell'utente sull'app, solo per le azioni con `needsUserToken`. `escludi` vale solo per le proposte: passi da non eseguire (es. \"p3\" o 3); i passi che usano il risultato di un passo escluso si saltano. Serve un token con l'ambito api:write. Per una proposta ripeti all'utente anche i passi esclusi. Prima di chiamarlo ripeti all'utente numero e sintesi della voce e chiedi conferma.",
      inputSchema: {
        numero: number,
        userToken: z.string().min(1).max(4_000).optional().describe("Token dell'utente sull'app"),
        escludi: z
          .array(z.union([z.string().max(10), z.number()]))
          .max(PROPOSAL_STEPS_MAX)
          .optional()
          .describe("Solo per le proposte: id dei passi da non eseguire, es. p3"),
      },
      annotations: { destructiveHint: true },
    },
    ({ numero, userToken, escludi }) => {
      if (!canDecide) return scopeError();
      return run("approva", async () => {
        const exclude = normalizeExclude(escludi);
        if (exclude === null) throw new CentralinoError(PROPOSAL_MESSAGES.badExclude);
        return approvePending(userId, numero, userToken, exclude);
      });
    },
  );

  server.registerTool(
    "rifiuta",
    {
      description:
        "Rifiuta una voce della coda, con una nota facoltativa (al massimo 500 caratteri) che il capo legge nel turno successivo. Serve un token con l'ambito api:write. Prima di chiamarlo ripeti all'utente numero e sintesi della voce e chiedi conferma.",
      inputSchema: { numero: number, nota: z.string().max(500).optional().describe("Motivo del rifiuto") },
      annotations: { destructiveHint: true },
    },
    ({ numero, nota }) => (canDecide ? run("rifiuta", () => rejectPending(userId, numero, nota)) : scopeError()),
  );
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
    const server = createMcpServer(opts.sources, req.mcpUserId!, req.mcpScopes); // impostati da requireApiToken
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
