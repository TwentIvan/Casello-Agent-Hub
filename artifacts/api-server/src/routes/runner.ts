import { Router, type IRouter, type RequestHandler, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, localMachinesTable } from "@workspace/db";
import { heartbeatJob, JOB_NOT_FOUND, LocalJobError, nextForMachine, reportItemDone, undeliverItem } from "../lib/local/jobs";
import { hashToken, tokenKind } from "../lib/local/tokens";
import { parseRequest } from "../middlewares/error-handler";
import { rateLimit } from "../middlewares/rate-limit";

// Protocollo del runner (`casello-runner`), fuori da OpenAPI e dalla sessione della console: solo token di
// macchina (`Authorization: Bearer csl_m_…`). Il runner vede soltanto i lavori della propria macchina.

const INVALID_TOKEN = "token non valido o revocato";

const DoneBody = z.object({
  sessionId: z.string().min(1).max(200).nullable(),
  exit: z.enum(["done", "error"]),
  usage: z
    .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
    .nullable(),
});

const JobIdParam = z.coerce.number().int().positive();

function machineIdOf(res: Response): number {
  return res.locals["machineId"] as number;
}

/**
 * Token di macchina non revocato. La ricerca è per hash sull'indice unico di `token_hash`: il token in chiaro non
 * si confronta mai con un valore salvato, quindi non serve un confronto a tempo costante.
 */
const machineAuth: RequestHandler = async (req, res, next) => {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (tokenKind(token) === "machine") {
    const [machine] = await db
      .select({ id: localMachinesTable.id })
      .from(localMachinesTable)
      .where(and(eq(localMachinesTable.tokenHash, hashToken(token)), isNull(localMachinesTable.revokedAt)))
      .limit(1);
    if (machine) {
      res.locals["machineId"] = machine.id;
      next();
      return;
    }
  }
  res.status(401).json({ error: INVALID_TOKEN });
};

/** Indirizzo del server MCP per Claude Code: l'origine pubblica di Casello o quella della richiesta. */
function mcpUrl(req: Parameters<RequestHandler>[0]): string {
  const publicUrl = process.env["PUBLIC_APP_URL"];
  const origin = publicUrl ? new URL(publicUrl).origin : `${req.protocol}://${req.get("host")}`;
  return `${origin}/api/mcp`;
}

function sendJobError(res: Response, err: unknown): void {
  if (!(err instanceof LocalJobError)) throw err;
  res.status(err.status).json({ error: err.message });
}

export function createRunnerRouter(): IRouter {
  const router: IRouter = Router();

  router.use(machineAuth);
  // 60 richieste al minuto per macchina (attesa lunga, segnali di vita e fine dei compiti insieme)
  router.use(rateLimit({ limit: 60, windowMs: 60_000, key: (_req, res) => `machine:${machineIdOf(res)}` }));

  // Attesa lunga: 204 se allo scadere non c'è nulla da fare. La richiesta chiusa dal runner interrompe l'attesa;
  // un compito consegnato a una richiesta chiusa prima della risposta torna in attesa di consegna.
  router.get("/next", async (req, res) => {
    const abort = new AbortController();
    let delivery: Awaited<ReturnType<typeof nextForMachine>> = null;
    res.on("close", () => {
      abort.abort();
      if (delivery && !res.writableFinished) void undeliverItem(delivery.jobId, delivery.itemId).catch(() => {});
    });
    delivery = await nextForMachine(machineIdOf(res), abort.signal);
    if (!delivery) {
      if (!res.headersSent && !abort.signal.aborted) res.status(204).end();
      return;
    }
    if (abort.signal.aborted) {
      await undeliverItem(delivery.jobId, delivery.itemId);
      return;
    }
    res.json({ ...delivery, mcpUrl: mcpUrl(req) });
  });

  router.post("/jobs/:id/heartbeat", async (req, res) => {
    const id = JobIdParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: JOB_NOT_FOUND });
      return;
    }
    try {
      await heartbeatJob(machineIdOf(res), id.data);
      res.status(204).end();
    } catch (err) {
      sendJobError(res, err);
    }
  });

  router.post("/items/:itemId/done", async (req, res) => {
    const body = parseRequest(DoneBody, req.body);
    const itemId = req.params.itemId;
    if (itemId.length > 100) {
      res.status(404).json({ error: JOB_NOT_FOUND });
      return;
    }
    try {
      await reportItemDone(machineIdOf(res), itemId, body);
      res.status(204).end();
    } catch (err) {
      sendJobError(res, err);
    }
  });

  return router;
}
