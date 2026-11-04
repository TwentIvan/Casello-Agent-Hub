import { Router, type IRouter, type Response } from "express";
import {
  ListTeamTemplatesQueryParams,
  ListTeamTemplatesResponse,
  CreateTeamTemplateBody,
  CreateTeamTemplateResponse,
  GetTeamTemplateParams,
  GetTeamTemplateResponse,
  SaveTeamTemplateParams,
  SaveTeamTemplateBody,
  SaveTeamTemplateResponse,
  GetTeamTemplateVersionParams,
  GetTeamTemplateVersionResponse,
  DeleteTeamTemplateParams,
  DeleteTeamTemplateResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { TeamRuleError } from "../lib/teams/rules";
import {
  TemplateError,
  createTemplate,
  deleteTemplate,
  describeRoles,
  getTemplate,
  getTemplateVersion,
  listTemplates,
  saveTemplate,
} from "../lib/teams/templates";
import { parseRequest } from "../middlewares/error-handler";

// Modelli di squadra. Con un token personale valgono gli ambiti per metodo (GET → api:read, il resto api:write).

/** Esegue la richiesta e traduce le violazioni delle regole e gli errori del modello nel loro stato HTTP. */
async function guarded(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof TeamRuleError) && !(err instanceof TemplateError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

const router: IRouter = Router();

router.get("/team-templates", async (req, res) => {
  const { archived } = parseRequest(ListTeamTemplatesQueryParams, req.query);
  res.json(ListTeamTemplatesResponse.parse(await listTemplates({ archived: archived === "true" })));
});

router.post("/team-templates", async (req, res) => {
  const body = parseRequest(CreateTeamTemplateBody, req.body);
  await guarded(res, async () => {
    res.status(201).json(CreateTeamTemplateResponse.parse(await createTemplate(currentUserId(req), body)));
  });
});

router.get("/team-templates/:id", async (req, res) => {
  const { id } = parseRequest(GetTeamTemplateParams, req.params);
  await guarded(res, async () => {
    res.json(GetTeamTemplateResponse.parse(await getTemplate(id)));
  });
});

router.put("/team-templates/:id", async (req, res) => {
  const { id } = parseRequest(SaveTeamTemplateParams, req.params);
  const body = parseRequest(SaveTeamTemplateBody, req.body);
  await guarded(res, async () => {
    res.json(SaveTeamTemplateResponse.parse(await saveTemplate(currentUserId(req), id, body)));
  });
});

router.delete("/team-templates/:id", async (req, res) => {
  const { id } = parseRequest(DeleteTeamTemplateParams, req.params);
  await guarded(res, async () => {
    res.json(DeleteTeamTemplateResponse.parse(await deleteTemplate(id)));
  });
});

router.get("/team-templates/:id/versions/:version", async (req, res) => {
  const { id, version } = parseRequest(GetTeamTemplateVersionParams, req.params);
  await guarded(res, async () => {
    res.json(GetTeamTemplateVersionResponse.parse(await describeRoles(await getTemplateVersion(id, version))));
  });
});

export default router;
