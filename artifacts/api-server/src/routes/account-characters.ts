import { Router, type IRouter } from "express";
import {
  GetCharacterSettingsResponse,
  UpdateCharacterSettingsBody,
  UpdateCharacterSettingsResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { getCharacterSettings, setCharacterSettings } from "../lib/characters/settings";
import { CharacterError } from "../lib/characters/types";
import { parseRequest } from "../middlewares/error-handler";

// Modelli e tetti di spesa di Alfred (chat) e Lucius nelle aree: impostazioni dell'account, solo con il login.

export function createAccountCharactersRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/characters", sessionOnly, async (req, res) => {
    res.json(GetCharacterSettingsResponse.parse(await getCharacterSettings(currentUserId(req))));
  });

  router.put("/account/characters", sessionOnly, async (req, res) => {
    const body = parseRequest(UpdateCharacterSettingsBody, req.body);
    const userId = currentUserId(req);
    try {
      await setCharacterSettings(userId, body);
    } catch (err) {
      if (!(err instanceof CharacterError)) throw err;
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.json(UpdateCharacterSettingsResponse.parse(await getCharacterSettings(userId)));
  });

  return router;
}
