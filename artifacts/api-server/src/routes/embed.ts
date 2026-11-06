import { Router, type IRouter } from "express";
import { GetEmbedConfigQueryParams, GetEmbedConfigResponse } from "@workspace/api-zod";
import { embedAppName } from "../lib/embed/clients";
import { embedAllowedOrigins, embedClientId, normalizeEmbedOrigin } from "../lib/embed/origins";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

// Pubblica: la pagina del plugin non deve poter distinguere un'origine non valida da una non ammessa.
router.get("/embed/config", async (req, res) => {
  const { origin } = parseRequest(GetEmbedConfigQueryParams, req.query);
  const normalized = origin ? normalizeEmbedOrigin(origin) : null;
  if (normalized === null || !embedAllowedOrigins().includes(normalized)) {
    res.json(GetEmbedConfigResponse.parse({ allowed: false, clientId: null, appName: null }));
    return;
  }
  res.json(GetEmbedConfigResponse.parse({ allowed: true, clientId: embedClientId(normalized), appName: await embedAppName(normalized) }));
});

export default router;
