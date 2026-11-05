import { Router, type IRouter } from "express";
import healthRouter from "./health";
import appsRouter from "./apps";
import appToolsRouter from "./app-tools";
import agentsRouter from "./agents";
import runsRouter from "./runs";
import dashboardRouter from "./dashboard";
import budgetRouter from "./budget";
import skillsRouter from "./skills";
import teamTemplatesRouter from "./team-templates";
import teamInstancesRouter from "./team-instances";
import githubRouter from "./github";
import { createAnalysesRouter } from "./analyses";
import { createPlanChatRouter } from "./plan-chat";
import { createPlanIssuesRouter } from "./plan-issues";
import { createAiRouter } from "./ai";
import { createCatalogRouter } from "./catalog";
import { createPendingActionsRouter } from "./pending-actions";
import { createApiTokensRouter } from "./api-tokens";
import { createAccountModelRouter } from "./account-model";
import { createNodesRouter } from "./nodes";
import { createNodeRouter } from "./node";
import { createOAuthGrantsRouter } from "./oauth-grants";
import { requireNodeToken } from "../lib/nodes/auth";
import { authRouter, requireAuth } from "../lib/auth";

const router: IRouter = Router();

// Pubbliche: healthcheck e login (/auth/me ha il suo requireAuth). Tutto il resto richiede una
// sessione o un token personale con l'ambito giusto (requireAuth).
router.use(healthRouter);
router.use(authRouter());
// Protocollo dei nodi: solo token d'ambito `node` (requireNodeToken), mai sessione né token personali;
// va prima di requireAuth, che a sua volta rifiuta i token `node` su tutto il resto di /api.
router.use("/node", requireNodeToken, createNodeRouter());
router.use(requireAuth);
router.use(appsRouter);
router.use(appToolsRouter);
router.use(agentsRouter);
router.use(runsRouter);
router.use(dashboardRouter);
router.use(budgetRouter);
router.use(skillsRouter);
router.use(teamTemplatesRouter);
router.use(teamInstancesRouter);
router.use(githubRouter);
router.use(createAnalysesRouter());
router.use(createPlanChatRouter());
router.use(createPlanIssuesRouter());
router.use(createAiRouter());
router.use(createCatalogRouter());
router.use(createPendingActionsRouter());
router.use(createApiTokensRouter());
router.use(createAccountModelRouter());
router.use(createNodesRouter());
router.use(createOAuthGrantsRouter());

export default router;
