import { Router, type IRouter } from "express";
import {
  ApproveNodePairingBody,
  ApproveNodePairingParams,
  ApproveNodePairingResponse,
  DenyNodePairingParams,
  DenyNodePairingResponse,
  GetNodePairingParams,
  GetNodePairingResponse,
  PollNodePairingBody,
  PollNodePairingResponse,
  StartNodePairingBody,
  StartNodePairingResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { NodeInputError, NodeNameConflictError } from "../lib/nodes/nodes";
import { PairingError, approvePairing, denyPairing, getPairing, pollPairing, startPairing } from "../lib/nodes/pairing";
import { parseRequest } from "../middlewares/error-handler";
import { nodePairingAccountLimit, nodePairingPollLimit, nodePairingStartLimit } from "../middlewares/rate-limit";

// Abbinamento dei nodi dal browser. Pubbliche: `start` e `poll` (le chiama il nodo prima di avere un token), con i loro
// limiti. Dell'account (solo login, mai token personali): dati, approvazione e rifiuto della richiesta.

/** Route pubbliche: montate prima di `requireAuth`. */
export function createNodePairingPublicRouter(): IRouter {
  const router: IRouter = Router();

  router.post("/node-pairing/start", nodePairingStartLimit, async (req, res) => {
    const body = parseRequest(StartNodePairingBody, req.body);
    const out = await startPairing({ deviceName: body.deviceName, version: body.version, ip: req.ip });
    res.status(201).json(StartNodePairingResponse.parse(out));
  });

  router.post("/node-pairing/poll", nodePairingPollLimit, async (req, res) => {
    const body = parseRequest(PollNodePairingBody, req.body);
    try {
      const out = await pollPairing(body.pairingId, body.pollSecret);
      // Lo schema generato descrive la risposta 200; la 202 `pending` ha solo lo stato
      if (out.status === "pending") res.status(202).json({ status: "pending" });
      else res.json(PollNodePairingResponse.parse(out));
    } catch (err) {
      if (err instanceof PairingError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}

/** Route dell'utente: solo con il login. */
export function createNodePairingAccountRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/node-pairings/:code", sessionOnly, nodePairingAccountLimit, async (req, res) => {
    const { code } = parseRequest(GetNodePairingParams, req.params);
    try {
      res.json(GetNodePairingResponse.parse(await getPairing(currentUserId(req), code)));
    } catch (err) {
      if (err instanceof PairingError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/account/node-pairings/:code/approve", sessionOnly, nodePairingAccountLimit, async (req, res) => {
    const { code } = parseRequest(ApproveNodePairingParams, req.params);
    const body = parseRequest(ApproveNodePairingBody, req.body);
    try {
      await approvePairing(currentUserId(req), code, { name: body.name, replaceNodeId: body.replaceNodeId });
      res.json(ApproveNodePairingResponse.parse({ status: "approved" }));
    } catch (err) {
      if (err instanceof PairingError) res.status(err.status).json({ error: err.message });
      else if (err instanceof NodeInputError) res.status(400).json({ error: err.message });
      else if (err instanceof NodeNameConflictError) res.status(409).json({ error: err.message });
      else throw err;
    }
  });

  router.post("/account/node-pairings/:code/deny", sessionOnly, nodePairingAccountLimit, async (req, res) => {
    const { code } = parseRequest(DenyNodePairingParams, req.params);
    try {
      await denyPairing(currentUserId(req), code);
      res.json(DenyNodePairingResponse.parse({ status: "denied" }));
    } catch (err) {
      if (err instanceof PairingError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
