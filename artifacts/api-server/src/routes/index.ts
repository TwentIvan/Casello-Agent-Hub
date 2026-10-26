import { Router, type IRouter } from "express";
import healthRouter from "./health";
import appsRouter from "./apps";
import appToolsRouter from "./app-tools";
import agentsRouter from "./agents";
import runsRouter from "./runs";
import dashboardRouter from "./dashboard";
import modelsRouter from "./models";
import githubRouter from "./github";
import { createAnalysesRouter } from "./analyses";
import { createAiRouter } from "./ai";
import { authRouter, requireAuth } from "../lib/auth";

const router: IRouter = Router();

// Pubbliche: healthcheck e login. Tutto il resto richiede una sessione.
router.use(healthRouter);
router.use(authRouter());
router.use(requireAuth);
router.use(appsRouter);
router.use(appToolsRouter);
router.use(agentsRouter);
router.use(runsRouter);
router.use(dashboardRouter);
router.use(modelsRouter);
router.use(githubRouter);
router.use(createAnalysesRouter());
router.use(createAiRouter());

export default router;
