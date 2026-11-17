import { Router, type IRouter, type Request, type Response } from "express";
import {
  AddAppBugMessageBody,
  AddAppBugMessageParams,
  AddAppBugMessageResponse,
  CloseAppBugBody,
  CloseAppBugParams,
  CloseAppBugResponse,
  CreateIdentitySecretParams,
  CreateIdentitySecretResponse,
  DeleteIdentitySecretParams,
  GetAppBugParams,
  GetAppBugResponse,
  GetBugSettingsParams,
  GetBugSettingsResponse,
  ListAppBugsParams,
  ListAppBugsQueryParams,
  ListAppBugsResponse,
  TestIdentityBody,
  TestIdentityParams,
  TestIdentityResponse,
  UpdateBugSettingsBody,
  UpdateBugSettingsParams,
  UpdateBugSettingsResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import {
  addOwnerMessage,
  bugSettings,
  clearIdentitySecret,
  closeAppBug,
  getAppBug,
  listAppBugs,
  setIdentitySecret,
  testIdentity,
  updateBugSettings,
} from "../lib/bugs/admin";
import { BugError } from "../lib/bugs/messages";
import { logger } from "../lib/logger";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

/** Esegue un gestore e traduce `BugError` in risposta JSON; altro errore → gestore finale. */
const guarded =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: (err?: unknown) => void): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof BugError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  };

router.get(
  "/apps/:id/bug-settings",
  guarded(async (req, res) => {
    const { id } = parseRequest(GetBugSettingsParams, req.params);
    res.json(GetBugSettingsResponse.parse(await bugSettings(id)));
  }),
);

router.patch(
  "/apps/:id/bug-settings",
  guarded(async (req, res) => {
    const { id } = parseRequest(UpdateBugSettingsParams, req.params);
    const body = parseRequest(UpdateBugSettingsBody, req.body);
    res.json(UpdateBugSettingsResponse.parse(await updateBugSettings(id, body)));
  }),
);

// Il segreto esce una sola volta e mai nei log; cambiarlo vuole il login
router.post(
  "/apps/:id/identity-secret",
  sessionOnly,
  guarded(async (req, res) => {
    const { id } = parseRequest(CreateIdentitySecretParams, req.params);
    const secret = await setIdentitySecret(id);
    logger.info({ appId: id }, "Segreto d'identità generato");
    res.status(201).set("Cache-Control", "no-store").json(CreateIdentitySecretResponse.parse({ secret }));
  }),
);

router.delete(
  "/apps/:id/identity-secret",
  sessionOnly,
  guarded(async (req, res) => {
    const { id } = parseRequest(DeleteIdentitySecretParams, req.params);
    await clearIdentitySecret(id);
    logger.info({ appId: id }, "Segreto d'identità tolto");
    res.status(204).end();
  }),
);

router.post(
  "/apps/:id/identity-test",
  guarded(async (req, res) => {
    const { id } = parseRequest(TestIdentityParams, req.params);
    const { token } = parseRequest(TestIdentityBody, req.body);
    res.json(TestIdentityResponse.parse(await testIdentity(id, token)));
  }),
);

router.get(
  "/apps/:id/bugs",
  guarded(async (req, res) => {
    const { id } = parseRequest(ListAppBugsParams, req.params);
    const { status } = parseRequest(ListAppBugsQueryParams, req.query);
    res.json(ListAppBugsResponse.parse(await listAppBugs(id, status)));
  }),
);

router.get(
  "/apps/:id/bugs/:number",
  guarded(async (req, res) => {
    const { id, number } = parseRequest(GetAppBugParams, req.params);
    res.json(GetAppBugResponse.parse(await getAppBug(id, number)));
  }),
);

router.post(
  "/apps/:id/bugs/:number/messages",
  guarded(async (req, res) => {
    const { id, number } = parseRequest(AddAppBugMessageParams, req.params);
    const { content } = parseRequest(AddAppBugMessageBody, req.body);
    res.status(201).json(AddAppBugMessageResponse.parse(await addOwnerMessage(id, number, content)));
  }),
);

router.post(
  "/apps/:id/bugs/:number/close",
  guarded(async (req, res) => {
    const { id, number } = parseRequest(CloseAppBugParams, req.params);
    const { status, message } = parseRequest(CloseAppBugBody, req.body);
    const detail = await closeAppBug(id, number, status, message, currentUserId(req));
    logger.info({ appId: id, number, status: detail.status }, "Segnalazione chiusa dall'amministratore");
    res.json(CloseAppBugResponse.parse(detail));
  }),
);

export default router;
