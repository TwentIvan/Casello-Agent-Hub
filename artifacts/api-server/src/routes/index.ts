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
import { createCatalogRouter } from "./catalog";
import { createLocalRouter } from "./local";
import { createRunnerRouter } from "./runner";
import { createMcpRouter } from "./mcp";
import { authRouter, requireAuth } from "../lib/auth";

const router: IRouter = Router();

// Pubbliche: healthcheck e login. Il runner dell'agente locale si autentica col token della macchina e il
// server MCP col token di lavoro o personale, mai con la sessione. Tutto il resto richiede una sessione.
router.use(healthRouter);
router.use(authRouter());
router.use("/runner", createRunnerRouter());
router.use("/mcp", createMcpRouter());
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
router.use(createCatalogRouter());
router.use(createLocalRouter());

export default router;
