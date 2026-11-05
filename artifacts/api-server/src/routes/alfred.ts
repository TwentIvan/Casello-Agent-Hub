import { Router, type IRouter } from "express";
import { GetAlfredSettingsResponse, SetAlfredSettingsBody, SetAlfredSettingsResponse } from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { ModelChoiceError } from "../lib/ai/choice";
import { AlfredError } from "../lib/alfred/gemini";
import { getAlfredSettings, setAlfredSettings } from "../lib/alfred/settings";
import { parseRequest } from "../middlewares/error-handler";

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

  return router;
}
