import { Router, type IRouter, type Response } from "express";
import {
  NodeClaimResponse,
  NodeGetAttachmentHeader,
  NodeGetAttachmentParams,
  NodeHeartbeatBody,
  NodeHeartbeatResponse,
  NodePingBody,
  NodePingParams,
  NodePingResponse,
  NodeReportBody,
  NodeReportParams,
  NodeTurnClaimResponse,
  NodeTurnPingBody,
  NodeTurnPingParams,
  NodeTurnPingResponse,
  NodeTurnReportBody,
  NodeTurnReportParams,
} from "@workspace/api-zod";
import { rfc5987 } from "../lib/teams/attachments";
import { currentNode } from "../lib/nodes/auth";
import { NodeError, claimTask, heartbeat, pingTask, reportTask, taskAttachment } from "../lib/nodes/protocol";
import { claimTurn, pingTurn, reportTurn, turnPollSettings } from "../lib/node-turns/protocol";
import { parseRequest } from "../middlewares/error-handler";
import {
  nodeClaimRateLimit,
  nodeHeartbeatRateLimit,
  nodePingRateLimit,
  nodeTurnClaimRateLimit,
  nodeTurnPingRateLimit,
} from "../middlewares/rate-limit";

// Protocollo dei nodi locali (/api/node/*): montato in routes/index.ts con requireNodeToken, quindi solo con un
// token d'ambito `node` di un nodo attivo. Il nodo è quello del token.

/** Il contratto dice `integer` ma lo Zod generato accetta qualsiasi numero: i token non interi → 400 (niente arrotondamento). */
const ReportBody = NodeReportBody.superRefine((body, ctx) => {
  for (const key of ["promptTokens", "completionTokens"] as const) {
    const value = body[key];
    if (value !== undefined && !Number.isInteger(value)) ctx.addIssue({ code: "custom", path: [key], message: "deve essere un numero intero" });
  }
});

const TurnReportBody = NodeTurnReportBody.superRefine((body, ctx) => {
  for (const key of ["promptTokens", "completionTokens", "cachedTokens"] as const) {
    const value = body[key];
    if (value !== undefined && !Number.isInteger(value)) ctx.addIssue({ code: "custom", path: [key], message: "deve essere un numero intero" });
  }
});

async function guarded(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof NodeError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
}

export function createNodeRouter(): IRouter {
  const router: IRouter = Router();

  router.post("/heartbeat", nodeHeartbeatRateLimit, async (req, res) => {
    const caps = parseRequest(NodeHeartbeatBody, req.body);
    await guarded(res, async () => {
      res.json(NodeHeartbeatResponse.parse(await heartbeat(currentNode(req).id, caps)));
    });
  });

  router.post("/claim", nodeClaimRateLimit, async (req, res) => {
    await guarded(res, async () => {
      const pkg = await claimTask(currentNode(req).id);
      if (!pkg) {
        res.status(204).end();
        return;
      }
      res.json(NodeClaimResponse.parse(pkg));
    });
  });

  router.post("/tasks/:id/ping", nodePingRateLimit, async (req, res) => {
    const { id } = parseRequest(NodePingParams, req.params);
    const { leaseToken } = parseRequest(NodePingBody, req.body);
    await guarded(res, async () => {
      res.json(NodePingResponse.parse(await pingTask(currentNode(req).id, id, leaseToken)));
    });
  });

  router.get("/tasks/:id/attachments/:attachmentId", async (req, res) => {
    const { id, attachmentId } = parseRequest(NodeGetAttachmentParams, req.params);
    const header = parseRequest(NodeGetAttachmentHeader, { "X-Lease-Token": req.get("x-lease-token") ?? "" });
    await guarded(res, async () => {
      const row = await taskAttachment(currentNode(req).id, id, header["X-Lease-Token"], attachmentId);
      res.set({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${rfc5987(row.name)}`,
        "X-Content-Type-Options": "nosniff",
      });
      res.send(row.content);
    });
  });

  router.post("/tasks/:id/report", async (req, res) => {
    const { id } = parseRequest(NodeReportParams, req.params);
    const body = parseRequest(ReportBody, req.body);
    await guarded(res, async () => {
      await reportTask(currentNode(req).id, id, body);
      res.status(204).end();
    });
  });

  // Turni delegati al nodo: la presa attende fino a 25 s; se il client chiude la richiesta l'attesa si annulla
  // (`res` «close» prima della risposta: quello di `req` arriva già a corpo letto).
  router.post("/turns/claim", nodeTurnClaimRateLimit, async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    await guarded(res, async () => {
      const pkg = await claimTurn(currentNode(req).id, turnPollSettings.waitMs, abort.signal);
      if (abort.signal.aborted) return;
      if (!pkg) {
        res.status(204).end();
        return;
      }
      res.json(NodeTurnClaimResponse.parse(pkg));
    });
  });

  router.post("/turns/:id/ping", nodeTurnPingRateLimit, async (req, res) => {
    const { id } = parseRequest(NodeTurnPingParams, req.params);
    const { leaseToken } = parseRequest(NodeTurnPingBody, req.body);
    await guarded(res, async () => {
      res.json(NodeTurnPingResponse.parse(await pingTurn(currentNode(req).id, id, leaseToken)));
    });
  });

  router.post("/turns/:id/report", async (req, res) => {
    const { id } = parseRequest(NodeTurnReportParams, req.params);
    const body = parseRequest(TurnReportBody, req.body);
    await guarded(res, async () => {
      await reportTurn(currentNode(req).id, id, body);
      res.status(204).end();
    });
  });

  return router;
}

export default createNodeRouter;
