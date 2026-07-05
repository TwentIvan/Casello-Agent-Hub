import { Router, type IRouter } from "express";
import healthRouter from "./health";
import appsRouter from "./apps";
import agentsRouter from "./agents";
import runsRouter from "./runs";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(appsRouter);
router.use(agentsRouter);
router.use(runsRouter);
router.use(dashboardRouter);

export default router;
