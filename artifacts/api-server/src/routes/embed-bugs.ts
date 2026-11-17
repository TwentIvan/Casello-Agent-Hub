import { Router, type IRouter, type Request, type Response } from "express";
import {
  AddEmbedBugMessageBody,
  AddEmbedBugMessageParams,
  AddEmbedBugMessageResponse,
  CreateEmbedBugBody,
  CreateEmbedBugResponse,
  GetEmbedBugParams,
  GetEmbedBugResponse,
  ListEmbedBugsResponse,
  MarkEmbedBugsSeenBody,
  MarkEmbedBugsSeenResponse,
} from "@workspace/api-zod";
import type { App } from "@workspace/db";
import { resolveEmbedBugApp, resolveRequester } from "../lib/bugs/embed-access";
import { BUG_MESSAGES, BugError } from "../lib/bugs/messages";
import {
  addReporterMessage,
  createBugReport,
  getForRequester,
  listForRequester,
  markSeen,
  type Requester,
} from "../lib/bugs/reports";
import { logger } from "../lib/logger";
import { parseRequest } from "../middlewares/error-handler";
import { consumeBugIpReport, consumeBugIpRequest } from "../middlewares/rate-limit";

const router: IRouter = Router();

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Controlli comuni: limite per IP, poi App (404 indistinguibile) e richiedente. Se qualcosa non va lancia `BugError`. */
async function access(req: Request): Promise<{ app: App; requester: Requester }> {
  if (!consumeBugIpRequest(req.ip ?? "")) throw new BugError(429, BUG_MESSAGES.tooMany);
  const app = await resolveEmbedBugApp(text(req.query["app"]), text(req.query["origin"]));
  if (!app) throw new BugError(404, BUG_MESSAGES.unavailable);
  const requester = await resolveRequester(app, text(req.header("x-botcave-browser-key")), text(req.header("x-botcave-identity")));
  return { app, requester };
}

function bugId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new BugError(404, BUG_MESSAGES.notFound);
  return id;
}

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

router.post(
  "/embed/bugs",
  guarded(async (req, res) => {
    const ctx = await access(req);
    const body = parseRequest(CreateEmbedBugBody, req.body);
    if (!consumeBugIpReport(req.ip ?? "")) throw new BugError(429, BUG_MESSAGES.tooMany);
    const row = await createBugReport(ctx.app, ctx.requester, body, req.ip ?? null);
    logger.info({ appId: ctx.app.id, bugId: row.id, number: row.number, status: row.status }, "Segnalazione registrata");
    res.status(201).json(CreateEmbedBugResponse.parse({ id: row.id, number: row.number, status: row.status }));
  }),
);

router.get(
  "/embed/bugs",
  guarded(async (req, res) => {
    const ctx = await access(req);
    res.json(ListEmbedBugsResponse.parse(await listForRequester(ctx.app.id, ctx.requester)));
  }),
);

// Prima di `/embed/bugs/:id`: «seen» non è un id
router.post(
  "/embed/bugs/seen",
  guarded(async (req, res) => {
    const ctx = await access(req);
    const { ids } = parseRequest(MarkEmbedBugsSeenBody, req.body);
    res.json(MarkEmbedBugsSeenResponse.parse({ updated: await markSeen(ctx.app.id, ctx.requester, ids) }));
  }),
);

router.get(
  "/embed/bugs/:id",
  guarded(async (req, res) => {
    const ctx = await access(req);
    const { id } = parseRequest(GetEmbedBugParams, req.params);
    const detail = await getForRequester(ctx.app.id, ctx.requester, bugId(String(id)));
    if (!detail) throw new BugError(404, BUG_MESSAGES.notFound);
    res.json(GetEmbedBugResponse.parse(detail));
  }),
);

router.post(
  "/embed/bugs/:id/messages",
  guarded(async (req, res) => {
    const ctx = await access(req);
    const { id } = parseRequest(AddEmbedBugMessageParams, req.params);
    const { content } = parseRequest(AddEmbedBugMessageBody, req.body);
    res.json(AddEmbedBugMessageResponse.parse(await addReporterMessage(ctx.app.id, ctx.requester, bugId(String(id)), content)));
  }),
);

export default router;
