import { Router, type IRouter } from "express";
import healthRouter from "./health";
import appsRouter from "./apps";
import appToolsRouter from "./app-tools";
import agentsRouter from "./agents";
import runsRouter from "./runs";
import dashboardRouter from "./dashboard";
import budgetRouter from "./budget";
import modelsRouter from "./models";
import githubRouter from "./github";
import { createAnalysesRouter } from "./analyses";
import { createPlanChatRouter } from "./plan-chat";
import { createPlanIssuesRouter } from "./plan-issues";
import { createAiRouter } from "./ai";
import { createCatalogRouter } from "./catalog";
import { createApiTokensRouter } from "./api-tokens";
import { createAccountModelRouter } from "./account-model";
import { authRouter, requireAuth } from "../lib/auth";

const router: IRouter = Router();

// Pubbliche: healthcheck e login (/auth/me ha il suo requireAuth). Tutto il resto richiede una
// sessione o un token personale con l'ambito giusto (requireAuth).
router.use(healthRouter);
router.use(authRouter());
router.use(requireAuth);
router.use(appsRouter);
router.use(appToolsRouter);
router.use(agentsRouter);
router.use(runsRouter);
router.use(dashboardRouter);
router.use(budgetRouter);
router.use(modelsRouter);
router.use(githubRouter);
router.use(createAnalysesRouter());
router.use(createPlanChatRouter());
router.use(createPlanIssuesRouter());
router.use(createAiRouter());
router.use(createCatalogRouter());
router.use(createApiTokensRouter());
router.use(createAccountModelRouter());

export default router;
