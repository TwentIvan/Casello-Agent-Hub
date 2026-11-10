import { Router, type IRouter } from "express";
import {
  CreateNodeBody,
  CreateNodeResponse,
  DeleteNodeParams,
  DisableNodeParams,
  DisableNodeResponse,
  GetNodeDiagnosticsParams,
  GetNodeDownloadResponse,
  GetNodeFoldersParams,
  GetNodeFoldersResponse,
  ListNodesResponse,
  RegenerateNodeTokenParams,
  RegenerateNodeTokenResponse,
  RequestNodeDiagnosticsParams,
  RequestNodeDiagnosticsResponse,
  RequestNodeUninstallParams,
  RequestNodeUninstallResponse,
  UpdateNodeSettingsParams,
  UpdateNodeSettingsResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import {
  NODE_MESSAGES,
  NodeInputError,
  NodeNameConflictError,
  createNode,
  deleteNode,
  disableNode,
  getNodeFolders,
  listNodes,
  regenerateNodeToken,
} from "../lib/nodes/nodes";
import { loadNodeManifest } from "../lib/nodes/manifest";
import {
  NODE_ADMIN_MESSAGES,
  getNodeDiagnostics,
  parseNodeSettings,
  requestNodeDiagnostics,
  requestNodeUninstall,
  updateNodeSettings,
} from "../lib/nodes/node-admin";
import { parseRequest } from "../middlewares/error-handler";
import { nodeDiagnosticsRequestRateLimit } from "../middlewares/rate-limit";

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

  router.get("/account/nodes/:id/folders", sessionOnly, async (req, res) => {
    const { id } = parseRequest(GetNodeFoldersParams, req.params);
    const out = await getNodeFolders(currentUserId(req), id);
    if (!out) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.json(GetNodeFoldersResponse.parse(out));
  });

  router.get("/account/nodes/download", sessionOnly, (_req, res) => {
    const manifest = loadNodeManifest();
    res.json(
      GetNodeDownloadResponse.parse(
        manifest
          ? { available: true, version: manifest.version, url: `/downloads/nodo/${manifest.app.file}`, size: manifest.app.size }
          : { available: false, version: null, url: null, size: null },
      ),
    );
  });

  router.put("/account/nodes/:id/settings", sessionOnly, async (req, res) => {
    const { id } = parseRequest(UpdateNodeSettingsParams, req.params);
    // Corpo letto a mano: ogni valore non valido ha lo stesso messaggio fisso
    const settings = parseNodeSettings(req.body);
    if (!settings) {
      res.status(400).json({ error: NODE_ADMIN_MESSAGES.settingsInvalid });
      return;
    }
    const node = await updateNodeSettings(currentUserId(req), id, settings);
    if (!node) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.json(UpdateNodeSettingsResponse.parse(node));
  });

  router.post("/account/nodes/:id/diagnostics-request", sessionOnly, nodeDiagnosticsRequestRateLimit, async (req, res) => {
    const { id } = parseRequest(RequestNodeDiagnosticsParams, req.params);
    const node = await requestNodeDiagnostics(currentUserId(req), id);
    if (!node) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.json(RequestNodeDiagnosticsResponse.parse(node));
  });

  router.get("/account/nodes/:id/diagnostics", sessionOnly, async (req, res) => {
    const { id } = parseRequest(GetNodeDiagnosticsParams, req.params);
    const content = await getNodeDiagnostics(currentUserId(req), id);
    if (content === null) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="diagnosi-nodo-${id}.txt"`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(content);
  });

  router.post("/account/nodes/:id/uninstall-request", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RequestNodeUninstallParams, req.params);
    const node = await requestNodeUninstall(currentUserId(req), id);
    if (!node) {
      res.status(404).json({ error: NODE_MESSAGES.notFound });
      return;
    }
    res.json(RequestNodeUninstallResponse.parse(node));
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
