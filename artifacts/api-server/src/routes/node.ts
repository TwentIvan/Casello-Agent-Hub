import { Router, type IRouter } from "express";
import { NodeHeartbeatResponse } from "@workspace/api-zod";

// Protocollo dei nodi locali (/api/node/*): montato in routes/index.ts con requireNodeToken, quindi
// solo con un token d'ambito `node` di un nodo attivo. Heartbeat minimo; il resto arriva con il protocollo completo.

export function createNodeRouter(): IRouter {
  const router: IRouter = Router();

  router.post("/heartbeat", (_req, res) => {
    res.json(NodeHeartbeatResponse.parse({ pending: 0 }));
  });

  return router;
}

export default createNodeRouter;
