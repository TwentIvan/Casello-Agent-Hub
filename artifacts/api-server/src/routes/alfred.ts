import { Router, type IRouter } from "express";
import {
  CloseAlfredSessionBody,
  CloseAlfredSessionParams,
  GetAlfredSettingsResponse,
  RecordAlfredUsageBody,
  RecordAlfredUsageParams,
  RenewAlfredSessionBody,
  RenewAlfredSessionParams,
  RunAlfredToolBody,
  RunAlfredToolParams,
  RunAlfredToolResponse,
  RenewAlfredSessionResponse,
  SetAlfredSettingsBody,
  SetAlfredSettingsResponse,
  StartAlfredSessionResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { ModelChoiceError } from "../lib/ai/choice";
import { AlfredError } from "../lib/alfred/gemini";
import { getAlfredSettings, setAlfredSettings } from "../lib/alfred/settings";
import { runAlfredTool } from "../lib/alfred/tools";
import { closeSession, recordUsage, renewSession, startSession } from "../lib/alfred/sessions";
import { parseRequest } from "../middlewares/error-handler";
import { consumeAlfredSession, consumeAlfredTool } from "../middlewares/rate-limit";

/** Errori di Alfred con messaggio fisso e stato; gli altri passano al gestore generale. */
function replyAlfredError(res: import("express").Response, err: unknown): boolean {
  if (!(err instanceof AlfredError)) return false;
  res.status(err.status).json({ error: err.message });
  return true;
}

// Alfred, maggiordomo vocale: solo con il login (un token personale non vale).

export function createAlfredRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/alfred", sessionOnly, async (req, res) => {
    res.json(GetAlfredSettingsResponse.parse(await getAlfredSettings(currentUserId(req))));
  });

  router.put("/account/alfred", sessionOnly, async (req, res) => {
    const body = parseRequest(SetAlfredSettingsBody, req.body);
    const userId = currentUserId(req);
    try {
      await setAlfredSettings(userId, body);
    } catch (err) {
      if (err instanceof AlfredError || err instanceof ModelChoiceError) {
        res.status(err instanceof AlfredError ? err.status : 400).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.json(SetAlfredSettingsResponse.parse(await getAlfredSettings(userId)));
  });

  router.post("/alfred/sessions", sessionOnly, async (req, res) => {
    const userId = currentUserId(req);
    if (!consumeAlfredSession(userId)) {
      res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
      return;
    }
    try {
      res.status(201).json(StartAlfredSessionResponse.parse(await startSession(userId)));
    } catch (err) {
      if (!replyAlfredError(res, err)) throw err;
    }
  });

  router.post("/alfred/sessions/:id/renew", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RenewAlfredSessionParams, req.params);
    // Corpo facoltativo; l'handle di ripresa non si registra mai nei log
    const { resumptionHandle } = parseRequest(RenewAlfredSessionBody, req.body ?? {});
    // Anche il rinnovo crea un token di Gemini: stesso limite dell'avvio
    if (!consumeAlfredSession(currentUserId(req))) {
      res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
      return;
    }
    try {
      res.json(RenewAlfredSessionResponse.parse(await renewSession(currentUserId(req), id, resumptionHandle)));
    } catch (err) {
      if (!replyAlfredError(res, err)) throw err;
    }
  });

  router.post("/alfred/sessions/:id/usage", sessionOnly, async (req, res) => {
    const { id } = parseRequest(RecordAlfredUsageParams, req.params);
    const body = parseRequest(RecordAlfredUsageBody, req.body);
    try {
      await recordUsage(currentUserId(req), id, body);
      res.status(204).end();
    } catch (err) {
      if (!replyAlfredError(res, err)) throw err;
    }
  });

  router.post("/alfred/sessions/:id/tools/:name", sessionOnly, async (req, res) => {
    const { id, name } = parseRequest(RunAlfredToolParams, req.params);
    const { args } = parseRequest(RunAlfredToolBody, req.body);
    if (!consumeAlfredTool(currentUserId(req))) {
      res.status(429).json({ error: "Troppe richieste: riprova tra poco" });
      return;
    }
    try {
      res.json(RunAlfredToolResponse.parse(await runAlfredTool(currentUserId(req), id, name, args)));
    } catch (err) {
      if (!replyAlfredError(res, err)) throw err;
    }
  });

  router.post("/alfred/sessions/:id/close", sessionOnly, async (req, res) => {
    const { id } = parseRequest(CloseAlfredSessionParams, req.params);
    // Corpo facoltativo; la trascrizione non si registra mai nei log
    const { transcript } = parseRequest(CloseAlfredSessionBody, req.body ?? {});
    try {
      await closeSession(currentUserId(req), id, transcript);
      res.status(204).end();
    } catch (err) {
      if (!replyAlfredError(res, err)) throw err;
    }
  });

  return router;
}
