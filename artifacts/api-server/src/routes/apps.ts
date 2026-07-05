import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, appsTable } from "@workspace/db";
import {
  ListAppsResponse,
  CreateAppBody,
  CreateAppResponse,
  GetAppParams,
  GetAppResponse,
  UpdateAppParams,
  UpdateAppBody,
  UpdateAppResponse,
  DeleteAppParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/apps", async (_req, res) => {
  const apps = await db.select().from(appsTable);
  res.json(ListAppsResponse.parse(apps));
});

router.post("/apps", async (req, res) => {
  const body = CreateAppBody.parse(req.body);
  const [app] = await db.insert(appsTable).values(body).returning();
  res.status(201).json(CreateAppResponse.parse(app));
});

router.get("/apps/:id", async (req, res) => {
  const { id } = GetAppParams.parse(req.params);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.json(GetAppResponse.parse(app));
});

router.patch("/apps/:id", async (req, res) => {
  const { id } = UpdateAppParams.parse(req.params);
  const body = UpdateAppBody.parse(req.body);
  const [app] = await db
    .update(appsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(appsTable.id, id))
    .returning();
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.json(UpdateAppResponse.parse(app));
});

router.delete("/apps/:id", async (req, res) => {
  const { id } = DeleteAppParams.parse(req.params);
  const [app] = await db.delete(appsTable).where(eq(appsTable.id, id)).returning();
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.status(204).end();
});

export default router;
