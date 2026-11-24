import { Router, type IRouter } from "express";
import {
  GetFleetResponse,
  PauseFleetBody,
  PauseFleetResponse,
  ResumeFleetResponse,
  UpdateFleetPolicyBody,
  UpdateFleetPolicyResponse,
} from "@workspace/api-zod";
import { currentUserId, sessionOnly } from "../lib/auth";
import { getFleet } from "../lib/fleet/service";
import {
  FLEET_MESSAGES,
  checkLimits,
  cleanPauseReason,
  pauseFleet,
  readFleetPolicy,
  resumeFleet,
  saveFleetLimits,
} from "../lib/fleet/policy";
import { scheduleRuns } from "../lib/run-queue";
import { parseRequest } from "../middlewares/error-handler";

// Flotta degli agenti (issue #117): vista con salute e attività (lettura con gli ambiti per metodo) e politica di
// coordinamento comune. Pausa, ripresa e limiti si cambiano solo con il login: valgono per tutte le run di tutti.

export function createFleetRouter(): IRouter {
  const router: IRouter = Router();

  router.get("/fleet", async (req, res) => {
    const view = await getFleet(currentUserId(req));
    res.json(GetFleetResponse.parse(view));
  });

  router.put("/fleet/policy", sessionOnly, async (req, res) => {
    const body = parseRequest(UpdateFleetPolicyBody, req.body);
    const check = checkLimits(body.maxRunningRuns, body.maxRunningPerAgent);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return;
    }
    await saveFleetLimits(currentUserId(req), body);
    // Limiti più larghi: le run in coda possono partire subito
    void scheduleRuns();
    res.json(UpdateFleetPolicyResponse.parse(await readFleetPolicy()));
  });

  router.post("/fleet/pause", sessionOnly, async (req, res) => {
    const body = parseRequest(PauseFleetBody, req.body ?? {});
    const reason = cleanPauseReason(body.reason);
    if (!reason.ok) {
      res.status(400).json({ error: reason.error });
      return;
    }
    if (!(await pauseFleet(currentUserId(req), reason.value))) {
      res.status(409).json({ error: FLEET_MESSAGES.alreadyPaused });
      return;
    }
    res.json(PauseFleetResponse.parse(await readFleetPolicy()));
  });

  router.post("/fleet/resume", sessionOnly, async (req, res) => {
    if (!(await resumeFleet(currentUserId(req)))) {
      res.status(409).json({ error: FLEET_MESSAGES.notPaused });
      return;
    }
    void scheduleRuns();
    res.json(ResumeFleetResponse.parse(await readFleetPolicy()));
  });

  return router;
}
