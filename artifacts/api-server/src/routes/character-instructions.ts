import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCharacterInstructionVersionParams,
  GetCharacterInstructionVersionResponse,
  GetCharacterInstructionsResponse,
  ListCharacterInstructionVersionsResponse,
  RestoreCharacterInstructionsBody,
  RestoreCharacterInstructionsResponse,
  UpdateCharacterInstructionsBody,
  UpdateCharacterInstructionsResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import {
  INSTRUCTION_MESSAGES,
  InstructionError,
  getCurrentInstructions,
  getInstructionVersion,
  listInstructionVersions,
  restoreInstructions,
  saveInstructions,
} from "../lib/characters/personal-instructions";
import type { Character } from "../lib/memory/types";
import { parseRequest } from "../middlewares/error-handler";
import { consumeInstructionWrite } from "../middlewares/rate-limit";

// Istruzioni personali di Alfred e Lucius: lettura con il login o un token di lettura, scritture solo con il login.

function fail(res: Response, err: unknown): void {
  if (!(err instanceof InstructionError)) throw err;
  res.status(err.status).json({ error: err.message });
}

/** Il personaggio del percorso: solo `alfred` e `lucius`, altrimenti 404 (risposta già inviata). */
function characterOf(req: Request, res: Response): Character | null {
  const c = req.params["character"];
  if (c === "alfred" || c === "lucius") return c;
  res.status(404).json({ error: INSTRUCTION_MESSAGES.characterNotFound });
  return null;
}

export function createCharacterInstructionsRouter(): IRouter {
  const router: IRouter = Router();
  const base = "/account/character-instructions/:character";

  router.get(base, async (req, res) => {
    const character = characterOf(req, res);
    if (!character) return;
    const cur = await getCurrentInstructions(currentUserId(req), character);
    res.json(GetCharacterInstructionsResponse.parse({ character, ...cur }));
  });

  router.get(`${base}/versions`, async (req, res) => {
    const character = characterOf(req, res);
    if (!character) return;
    res.json(ListCharacterInstructionVersionsResponse.parse(await listInstructionVersions(currentUserId(req), character)));
  });

  router.get(`${base}/versions/:version`, async (req, res) => {
    const character = characterOf(req, res);
    if (!character) return;
    const { version } = parseRequest(GetCharacterInstructionVersionParams.pick({ version: true }), req.params);
    try {
      res.json(GetCharacterInstructionVersionResponse.parse(await getInstructionVersion(currentUserId(req), character, version)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.put(base, sessionOnly, async (req, res) => {
    const character = characterOf(req, res);
    if (!character) return;
    const body = parseRequest(UpdateCharacterInstructionsBody, req.body);
    const userId = currentUserId(req);
    if (!consumeInstructionWrite(userId)) {
      res.status(429).json({ error: INSTRUCTION_MESSAGES.rateLimited });
      return;
    }
    try {
      const saved = await saveInstructions(userId, character, body.content, body.baseVersion);
      res.json(UpdateCharacterInstructionsResponse.parse({ character, ...saved }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post(`${base}/restore`, sessionOnly, async (req, res) => {
    const character = characterOf(req, res);
    if (!character) return;
    const body = parseRequest(RestoreCharacterInstructionsBody, req.body);
    const userId = currentUserId(req);
    if (!consumeInstructionWrite(userId)) {
      res.status(429).json({ error: INSTRUCTION_MESSAGES.rateLimited });
      return;
    }
    try {
      const saved = await restoreInstructions(userId, character, body.version, body.baseVersion);
      res.json(RestoreCharacterInstructionsResponse.parse({ character, ...saved }));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
