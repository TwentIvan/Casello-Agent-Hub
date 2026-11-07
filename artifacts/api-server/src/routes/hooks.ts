import express, { Router, type ErrorRequestHandler, type IRouter } from "express";
import { logger } from "../lib/logger";
import { webhookIpRateLimit } from "../middlewares/rate-limit";
import { handleWebhook } from "../lib/triggers/webhook";
import { TRIGGER_MESSAGES } from "../lib/triggers/messages";

// Webhook in entrata degli inneschi (spec §5): pubblico, montato in app.ts prima di CORS, dei parser globali e
// della sessione. Il limite per IP (120/min) viene prima della lettura del corpo, che ha un parser grezzo proprio
// (≤ 256 KB); quello per innesco (60/min) lo conta `handleWebhook` dopo segreto e firma. Nei log solo id ed esito: il percorso con il segreto lo oscura il serializer di app.ts.

export function hooksRouter(): IRouter {
  const router: IRouter = Router();
  router.post(
    "/:triggerId/:secret",
    webhookIpRateLimit,
    express.raw({ type: () => true, limit: "256kb" }),
    async (req, res, next) => {
      try {
        const rawId = String(req.params["triggerId"]);
        const result = await handleWebhook({
          triggerId: /^\d{1,15}$/.test(rawId) ? Number(rawId) : Number.NaN,
          secret: String(req.params["secret"]),
          contentType: req.get("content-type"),
          rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          signature: req.get("x-hub-signature-256"),
          dedupHeaderValue: (name) => req.get(name),
        });
        if (result.retryAfter !== undefined) res.setHeader("Retry-After", result.retryAfter);
        res.status(result.status).json(result.body);
      } catch (err) {
        next(err);
      }
    },
  );
  // Errori del parser (corpo troppo grande, codifica non supportata) ed errori interni: messaggi fissi, mai il corpo.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const type = (err as { type?: unknown }).type;
    const status = Number((err as { status?: unknown }).status);
    if (type === "entity.too.large") {
      res.status(413).json({ error: TRIGGER_MESSAGES.bodyTooLarge });
      return;
    }
    if (type === "encoding.unsupported" || type === "charset.unsupported") {
      res.status(415).json({ error: TRIGGER_MESSAGES.unsupportedType });
      return;
    }
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(400).json({ error: TRIGGER_MESSAGES.invalidBody });
      return;
    }
    logger.error({ errName: err instanceof Error ? err.name : typeof err }, "Webhook dell'innesco non riuscito");
    res.status(500).json({ error: TRIGGER_MESSAGES.hookFailed });
  };
  router.use(onError);
  return router;
}
