import { Router, type IRouter } from "express";
import { ListModelsResponse } from "@workspace/api-zod";
import { AVAILABLE_MODELS, DEFAULT_MODEL } from "../lib/models";

const router: IRouter = Router();

router.get("/models", (_req, res) => {
  const models = AVAILABLE_MODELS.map((m) => ({ ...m, isDefault: m.id === DEFAULT_MODEL }));
  res.json(ListModelsResponse.parse(models));
});

export default router;
