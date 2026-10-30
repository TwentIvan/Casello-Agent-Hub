import { Router, type IRouter, type RequestHandler } from "express";
import { CreatePlanIssuesBody, CreatePlanIssuesParams, CreatePlanIssuesResponse } from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { PlanIssuesError, createPlanIssues, previewPlanIssues } from "../lib/plan-issues/service";
import { issueCreateRateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

// Issue GitHub dalle voci approvate del piano: anteprima (dryRun) e creazione sul repo dell'app.

const DUPLICATE_IDS = "Voci ripetute nella richiesta";

export function createPlanIssuesRouter(
  opts: { pauseMs?: number; createRateLimit?: RequestHandler } = {},
): IRouter {
  const router: IRouter = Router();
  const limit = opts.createRateLimit ?? issueCreateRateLimit;
  // Le anteprime non chiamano GitHub: non consumano il limite delle creazioni
  const createLimit: RequestHandler = (req, res, next) =>
    (req.body as { dryRun?: unknown } | undefined)?.dryRun === true ? next() : limit(req, res, next);

  router.post("/apps/:id/plan/issues", createLimit, async (req, res) => {
    const { id } = parseRequest(CreatePlanIssuesParams, req.params);
    const { itemIds, dryRun } = parseRequest(CreatePlanIssuesBody, req.body);
    if (new Set(itemIds).size !== itemIds.length) {
      res.status(400).json({ error: DUPLICATE_IDS });
      return;
    }
    const userId = currentUserId(req);
    try {
      const out = dryRun
        ? await previewPlanIssues(id, userId, itemIds)
        : await createPlanIssues(id, userId, itemIds, { pauseMs: opts.pauseMs });
      res.json(CreatePlanIssuesResponse.parse(out));
    } catch (e) {
      if (e instanceof PlanIssuesError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

  return router;
}
