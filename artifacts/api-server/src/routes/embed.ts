import { Router, type IRouter } from "express";
import { GetEmbedConfigQueryParams, GetEmbedConfigResponse } from "@workspace/api-zod";
import { hasIdentitySecret, resolveEmbedBugApp } from "../lib/bugs/embed-access";
import { embedAppName } from "../lib/embed/clients";
import { embedAllowedOrigins, embedClientId, normalizeEmbedOrigin } from "../lib/embed/origins";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

// Pubblica: la pagina del plugin non deve poter distinguere un'origine non valida da una non ammessa.
router.get("/embed/config", async (req, res) => {
  const { origin, app } = parseRequest(GetEmbedConfigQueryParams, req.query);
  const normalized = origin ? normalizeEmbedOrigin(origin) : null;
  if (normalized === null || !embedAllowedOrigins().includes(normalized)) {
    res.json(GetEmbedConfigResponse.parse({ allowed: false, clientId: null, appName: null, bugs: { enabled: false, identity: false } }));
    return;
  }
  const bugApp = await resolveEmbedBugApp(app, normalized);
  const bugs = { enabled: bugApp !== null, identity: bugApp ? hasIdentitySecret(bugApp) : false };
  res.json(GetEmbedConfigResponse.parse({ allowed: true, clientId: embedClientId(normalized), appName: await embedAppName(normalized), bugs }));
});

export default router;
