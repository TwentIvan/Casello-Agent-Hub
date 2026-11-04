import { Router, type IRouter } from "express";
import {
  CreateNodeBody,
  CreateNodeResponse,
  DeleteNodeParams,
  DisableNodeParams,
  DisableNodeResponse,
  ListNodesResponse,
  RegenerateNodeTokenParams,
  RegenerateNodeTokenResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import {
  NODE_MESSAGES,
  NodeInputError,
  NodeNameConflictError,
  createNode,
  deleteNode,
  disableNode,
  listNodes,
  regenerateNodeToken,
} from "../lib/nodes/nodes";
import { parseRequest } from "../middlewares/error-handler";

// Nodi locali dell'utente e i loro token: si gestiscono solo con il login. Un nodo di un altro utente è
// come se non esistesse (404). Il token compare solo nelle risposte di creazione e rigenerazione.

export function createNodesRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/nodes", sessionOnly, async (req, res) => {
    res.json(ListNodesResponse.parse(await listNodes(currentUserId(req))));
  });

  router.post("/account/nodes", sessionOnly, async (req, res) => {
    const body = parseRequest(CreateNodeBody, req.body);
    try {
      res.status(201).json(CreateNodeResponse.parse(await createNode(currentUserId(req), body.name)));
    } catch (err) {
      if (err instanceof NodeInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof NodeNameConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/account/nodes/:id/disable", sessionOnly, async (req, res) => {
    const { id } = parseRequest(DisableNodeParams, req.params);
    const node = await disableNode(currentUserId(req), id);
    if (!node) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.json(DisableNodeResponse.parse(node));
  });

  router.post("/account/nodes/:id/token", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RegenerateNodeTokenParams, req.params);
    const out = await regenerateNodeToken(currentUserId(req), id);
    if (!out) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.json(RegenerateNodeTokenResponse.parse(out));
  });

  router.delete("/account/nodes/:id", sessionOnly, async (req, res) => {
    const { id } = parseRequest(DeleteNodeParams, req.params);
    if (!(await deleteNode(currentUserId(req), id))) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.status(204).end();
  });

  return router;
}

export default createNodesRouter;
