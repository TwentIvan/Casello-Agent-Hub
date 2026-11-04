import { Router, type IRouter, type Response } from "express";
import {
  ListSkillsQueryParams,
  ListSkillsResponse,
  CreateSkillBody,
  GetSkillParams,
  GetSkillResponse,
  UpdateSkillParams,
  UpdateSkillBody,
  UpdateSkillResponse,
  DeprecateSkillParams,
  DeprecateSkillResponse,
  ListSkillVersionsParams,
  ListSkillVersionsResponse,
  GetSkillVersionParams,
  GetSkillVersionResponse,
} from "@workspace/api-zod";
import {
  SkillError,
  createSkill,
  deprecateSkill,
  getSkill,
  getSkillVersion,
  listSkillVersions,
  listSkills,
  updateSkill,
} from "../lib/teams/skills";
import { parseRequest } from "../middlewares/error-handler";

// Catalogo delle skill codificate e versionate. Con un token personale valgono gli ambiti per metodo.

/** Esegue la richiesta e traduce gli errori del catalogo nel loro stato HTTP. */
async function guarded(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof SkillError)) throw err;
    res.status(err.status).json({ error: err.message });
  }
}

const router: IRouter = Router();

router.get("/skills", async (req, res) => {
  const { kind, q, deprecated } = parseRequest(ListSkillsQueryParams, req.query);
  const filter = { kind, q, deprecated: deprecated === undefined ? undefined : deprecated === "true" };
  res.json(ListSkillsResponse.parse(await listSkills(filter)));
});

router.post("/skills", async (req, res) => {
  const body = parseRequest(CreateSkillBody, req.body);
  await guarded(res, async () => {
    res.status(201).json(GetSkillResponse.parse(await createSkill(body)));
  });
});

router.get("/skills/:code", async (req, res) => {
  const { code } = parseRequest(GetSkillParams, req.params);
  await guarded(res, async () => {
    res.json(GetSkillResponse.parse(await getSkill(code)));
  });
});

router.patch("/skills/:code", async (req, res) => {
  const { code } = parseRequest(UpdateSkillParams, req.params);
  const body = parseRequest(UpdateSkillBody, req.body);
  await guarded(res, async () => {
    res.json(UpdateSkillResponse.parse(await updateSkill(code, body)));
  });
});

router.post("/skills/:code/deprecate", async (req, res) => {
  const { code } = parseRequest(DeprecateSkillParams, req.params);
  await guarded(res, async () => {
    res.json(DeprecateSkillResponse.parse(await deprecateSkill(code)));
  });
});

router.get("/skills/:code/versions", async (req, res) => {
  const { code } = parseRequest(ListSkillVersionsParams, req.params);
  await guarded(res, async () => {
    res.json(ListSkillVersionsResponse.parse(await listSkillVersions(code)));
  });
});

router.get("/skills/:code/versions/:version", async (req, res) => {
  const { code, version } = parseRequest(GetSkillVersionParams, req.params);
  await guarded(res, async () => {
    res.json(GetSkillVersionResponse.parse(await getSkillVersion(code, version)));
  });
});

export default router;
