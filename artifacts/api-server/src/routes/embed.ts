import { Router, type IRouter } from "express";
import { GetEmbedConfigQueryParams, GetEmbedConfigResponse, GetEmbedStatusQueryParams, GetEmbedStatusResponse } from "@workspace/api-zod";
import { currentUserId, sessionOrEmbed } from "../lib/auth";
import { HttpError } from "../lib/ai/node-account";
import { PAGE_ACTION_MESSAGES } from "../lib/apps/page-actions";
import { requireHostApp } from "../lib/embed/host-app";
import { embedStatus, recordPageSeen } from "../lib/embed/status";
import { consumeEmbedStatus } from "../middlewares/rate-limit";
import { hasIdentitySecret, resolveEmbedBugApp } from "../lib/bugs/embed-access";
import { embedAppName } from "../lib/embed/clients";
import { embedAllowedOrigins, embedClientId, normalizeEmbedOrigin } from "../lib/embed/origins";
import { parseRequest } from "../middlewares/error-handler";

const PAGE_RE = /^[A-Za-z0-9._:-]{1,40}$/;

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

// Con autenticazione (montata dopo requireAuth): solo sessione o token del pannello.
export const embedStatusRouter: IRouter = Router();

embedStatusRouter.get("/embed/status", sessionOrEmbed, async (req, res) => {
  const { app: slug, page } = parseRequest(GetEmbedStatusQueryParams, req.query);
  if (!PAGE_RE.test(page)) {
    res.status(400).json({ error: PAGE_ACTION_MESSAGES.page });
    return;
  }
  const userId = currentUserId(req);
  const auth = req.auth;
  const key = auth?.kind === "token" && auth.via === "embed" ? `embed:${auth.grantId}` : `user:${userId}`;
  if (!consumeEmbedStatus(key)) {
    res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
    return;
  }
  try {
    const app = await requireHostApp(req, slug);
    await recordPageSeen(app.id, page);
    res.json(GetEmbedStatusResponse.parse(await embedStatus(userId, app, page)));
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
});

export default router;
