import { Router, type IRouter, type Response } from "express";
import {
  NodeClaimResponse,
  NodeHeartbeatBody,
  NodeHeartbeatResponse,
  NodePingBody,
  NodePingParams,
  NodePingResponse,
  NodeReportBody,
  NodeReportParams,
} from "@workspace/api-zod";
import { currentNode } from "../lib/nodes/auth";
import { NodeError, claimTask, heartbeat, pingTask, reportTask } from "../lib/nodes/protocol";
import { parseRequest } from "../middlewares/error-handler";
import { nodeClaimRateLimit, nodeHeartbeatRateLimit, nodePingRateLimit } from "../middlewares/rate-limit";

// Protocollo dei nodi locali (/api/node/*): montato in routes/index.ts con requireNodeToken, quindi solo con un
// token d'ambito `node` di un nodo attivo. Il nodo è quello del token.

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

  router.post("/tasks/:id/report", async (req, res) => {
    const { id } = parseRequest(NodeReportParams, req.params);
    const body = parseRequest(NodeReportBody, req.body);
    await guarded(res, async () => {
      await reportTask(currentNode(req).id, id, body);
      res.status(204).end();
    });
  });

  return router;
}

export default createNodeRouter;
