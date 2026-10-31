import { Router, type IRouter } from "express";
import { GetDefaultModelResponse, SetDefaultModelBody, SetDefaultModelResponse } from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { ModelChoiceError } from "../lib/ai/choice";
import { getDefaultModel, setDefaultModel } from "../lib/ai/default-model";
import { parseRequest } from "../middlewares/error-handler";

// Modello predefinito dell'utente: precompila la scelta del modello degli agenti che Casello crea.
// Impostazione dell'account: solo con il login, un token non può cambiarla (né leggerla).

export function createAccountModelRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/account/default-model", sessionOnly, async (req, res) => {
    res.json(GetDefaultModelResponse.parse({ aiModelId: await getDefaultModel(currentUserId(req)) }));
  });

  router.put("/account/default-model", sessionOnly, async (req, res) => {
    const { aiModelId } = parseRequest(SetDefaultModelBody, req.body);
    const userId = currentUserId(req);
    try {
      await setDefaultModel(userId, aiModelId);
    } catch (err) {
      if (!(err instanceof ModelChoiceError)) throw err;
      res.status(400).json({ error: err.message });
      return;
    }
    res.json(SetDefaultModelResponse.parse({ aiModelId: await getDefaultModel(userId) }));
  });

  return router;
}
