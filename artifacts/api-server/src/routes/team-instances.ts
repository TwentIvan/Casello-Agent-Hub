import { Router, type IRouter, type Response } from "express";
import {
  ListTeamInstancesQueryParams,
  ListTeamInstancesResponse,
  CreateTeamInstanceBody,
  GetTeamInstanceParams,
  GetTeamInstanceResponse,
  SaveTeamInstanceParams,
  SaveTeamInstanceBody,
  SaveTeamInstanceResponse,
  CloseTeamInstanceParams,
  CloseTeamInstanceResponse,
  CreateTeamInstanceResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { InstanceError, closeInstance, createInstance, getInstance, listInstances, saveInstance } from "../lib/teams/instances";
import { TeamRuleError } from "../lib/teams/rules";
import { TemplateError } from "../lib/teams/templates";
import { parseRequest } from "../middlewares/error-handler";

// Squadre (istanze di modelli) legate a un lavoro. Con un token personale valgono gli ambiti per metodo.

/** Esegue la richiesta e traduce le violazioni delle regole e gli errori di istanza/modello nel loro stato HTTP. */
async function guarded(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof TeamRuleError) && !(err instanceof TemplateError) && !(err instanceof InstanceError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

const router: IRouter = Router();

router.get("/team-instances", async (req, res) => {
  const filter = parseRequest(ListTeamInstancesQueryParams, req.query);
  res.json(ListTeamInstancesResponse.parse(await listInstances(filter)));
});

router.post("/team-instances", async (req, res) => {
  const body = parseRequest(CreateTeamInstanceBody, req.body);
  await guarded(res, async () => {
    res.status(201).json(CreateTeamInstanceResponse.parse(await createInstance(currentUserId(req), body)));
  });
});

router.get("/team-instances/:id", async (req, res) => {
  const { id } = parseRequest(GetTeamInstanceParams, req.params);
  await guarded(res, async () => {
    res.json(GetTeamInstanceResponse.parse(await getInstance(id)));
  });
});

router.put("/team-instances/:id", async (req, res) => {
  const { id } = parseRequest(SaveTeamInstanceParams, req.params);
  const body = parseRequest(SaveTeamInstanceBody, req.body);
  await guarded(res, async () => {
    res.json(SaveTeamInstanceResponse.parse(await saveInstance(currentUserId(req), id, body)));
  });
});

router.post("/team-instances/:id/close", async (req, res) => {
  const { id } = parseRequest(CloseTeamInstanceParams, req.params);
  await guarded(res, async () => {
    res.json(CloseTeamInstanceResponse.parse(await closeInstance(id)));
  });
});

export default router;
