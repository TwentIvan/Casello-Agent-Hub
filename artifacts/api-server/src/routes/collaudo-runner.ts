// Protocollo del runner di collaudo (/api/collaudo/*): connessioni solo in uscita dal runner di GitHub Actions.
// `claim` è pubblica (codice monouso, 10/min per IP); le altre vogliono il token `ctk_…` (requireCollaudoToken).
// Montata in routes/index.ts prima di requireAuth.

import express, { Router, type IRouter, type RequestHandler } from "express";
import { z } from "zod";
import { CollaudoClaimBody, CollaudoReportBody, CollaudoResultBody, CollaudoResultParams, CollaudoTunnelBody } from "@workspace/api-zod";
import { currentCollaudo, requireCollaudoToken } from "../lib/collaudo/auth";
import { nextCommand, releaseCommand, saveCommandResult } from "../lib/collaudo/commands";
import {
  MAX_VIDEO_BYTES,
  PROTOCOL_MESSAGES,
  claim,
  isDelivered,
  ping,
  report,
  saveFile,
  setTunnel,
} from "../lib/collaudo/protocol";
import { CollaudoProtocolError } from "../lib/collaudo/tokens";
import { parseRequest } from "../middlewares/error-handler";
import { collaudoClaimRateLimit } from "../middlewares/rate-limit";

const NEXT_WAIT_MS = 25_000;

// Schemi del contratto; gli interi si stringono qui (il generatore li produce come numeri)
const ClaimBody = CollaudoClaimBody.extend({ testId: z.number().int().positive() });
const ResultParams = CollaudoResultParams.extend({ commandId: z.coerce.number().int().positive() });

/** Errori di regola con il loro stato; gli altri salgono al gestore comune. */
const handled =
  (fn: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      if (err instanceof CollaudoProtocolError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    }
  };

export function createCollaudoRunnerRouter(): IRouter {
  const router: IRouter = Router();

  router.post(
    "/claim",
    collaudoClaimRateLimit,
    handled(async (req, res) => {
      const body = parseRequest(ClaimBody, req.body);
      const pkg = await claim(body.testId, body.code);
      if (!pkg) {
        res.status(401).json({ error: "codice non valido o scaduto" });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json(pkg);
    }),
  );

  router.use(requireCollaudoToken);

  router.post(
    "/next",
    handled(async (req, res) => {
      const { testId } = currentCollaudo(req);
      if (await isDelivered(testId)) {
        res.status(410).json({ error: PROTOCOL_MESSAGES.delivered });
        return;
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const found = await nextCommand(testId, NEXT_WAIT_MS, controller.signal);
      if (controller.signal.aborted) {
        // La connessione è chiusa: un comando già preso non va perso
        if (found) await releaseCommand(testId, found.id);
        return;
      }
      if (!found) {
        if (await isDelivered(testId)) {
          res.status(410).json({ error: PROTOCOL_MESSAGES.delivered });
          return;
        }
        res.status(204).end();
        return;
      }
      res.json(found);
    }),
  );

  router.post(
    "/results/:commandId",
    handled(async (req, res) => {
      const { testId } = currentCollaudo(req);
      const { commandId } = parseRequest(ResultParams, req.params);
      const body = parseRequest(CollaudoResultBody, req.body);
      if (!(await saveCommandResult(testId, commandId, body))) {
        res.status(404).json({ error: PROTOCOL_MESSAGES.commandNotFound });
        return;
      }
      res.status(204).end();
    }),
  );

  router.post(
    "/ping",
    handled(async (req, res) => {
      const leaseExpiresAt = await ping(currentCollaudo(req).testId);
      res.json({ leaseExpiresAt: leaseExpiresAt.toISOString() });
    }),
  );

  router.post(
    "/tunnel",
    handled(async (req, res) => {
      const body = parseRequest(CollaudoTunnelBody, req.body);
      await setTunnel(currentCollaudo(req).testId, body.url, body.until);
      res.status(204).end();
    }),
  );

  // Corpo grezzo (video fino a 30 MB): oltre il limite 413 prima di leggere il resto
  const raw = express.raw({ type: () => true, limit: MAX_VIDEO_BYTES });
  router.post(
    "/files",
    (req, res, next) => {
      raw(req, res, (err?: unknown) => {
        if (err && (err as { type?: unknown }).type === "entity.too.large") {
          res.status(413).json({ error: PROTOCOL_MESSAGES.fileTooLarge });
          return;
        }
        next(err);
      });
    },
    handled(async (req, res) => {
      const saved = await saveFile(currentCollaudo(req).testId, {
        kind: req.get("x-file-kind"),
        name: req.get("x-file-name"),
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      res.status(201).json(saved);
    }),
  );

  router.post(
    "/report",
    handled(async (req, res) => {
      const body = parseRequest(CollaudoReportBody, req.body);
      await report(currentCollaudo(req).testId, body.status);
      res.status(204).end();
    }),
  );

  return router;
}
