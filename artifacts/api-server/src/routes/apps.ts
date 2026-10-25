import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, appsTable, agentsTable } from "@workspace/db";
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
import { encryptSecret } from "../lib/secrets";
import { uniqueSlug, withSlugRetry } from "../lib/slug";
import { toPublicApp } from "./serializers";
import { parseRequest } from "../middlewares/error-handler";

const router: IRouter = Router();

router.get("/apps", async (_req, res) => {
  const apps = await db.select().from(appsTable).orderBy(asc(appsTable.id));
  res.json(ListAppsResponse.parse(apps.map(toPublicApp)));
});

// Creazione dell'app e del suo agente generale in un'unica transazione. Lo slug segue la regola
// della migrazione, che in caso di collisione usa l'id: si inserisce con uno slug provvisorio
// univoco e lo si sostituisce appena noto l'id. Se una creazione concorrente prende lo stesso slug,
// la transazione fallisce sulla unique e si riprova da capo (withSlugRetry).
router.post("/apps", async (req, res) => {
  const { serviceSecret, ...body } = parseRequest(CreateAppBody, req.body);
  const serviceSecretEnc = serviceSecret !== undefined ? encryptSecret(serviceSecret) : null;

  const app = await withSlugRetry(() => db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(appsTable)
      .values({ ...body, slug: `tmp-${randomUUID()}`, serviceSecretEnc })
      .returning();
    const slug = await uniqueSlug(body.name, inserted!.id, async (candidate) => {
      const [row] = await tx
        .select({ id: appsTable.id })
        .from(appsTable)
        .where(eq(appsTable.slug, candidate))
        .limit(1);
      return !!row;
    });
    const [created] = await tx.update(appsTable).set({ slug }).where(eq(appsTable.id, inserted!.id)).returning();
    await tx.insert(agentsTable).values({
      appId: created!.id,
      name: `${created!.name} – generale`,
      role: "general",
      status: "draft",
    });
    return created!;
  }));

  res.status(201).json(CreateAppResponse.parse(toPublicApp(app)));
});

router.get("/apps/:id", async (req, res) => {
  const { id } = parseRequest(GetAppParams, req.params);
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, id)).limit(1);
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.json(GetAppResponse.parse(toPublicApp(app)));
});

router.patch("/apps/:id", async (req, res) => {
  const { id } = parseRequest(UpdateAppParams, req.params);
  const { serviceSecret, ...body } = parseRequest(UpdateAppBody, req.body);
  // serviceSecret: stringa → cifrato e salvato; null → cancellato; assente → invariato
  const secretChange =
    serviceSecret === undefined
      ? {}
      : { serviceSecretEnc: serviceSecret === null ? null : encryptSecret(serviceSecret) };
  const [app] = await db
    .update(appsTable)
    .set({ ...body, ...secretChange, updatedAt: new Date() })
    .where(eq(appsTable.id, id))
    .returning();
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.json(UpdateAppResponse.parse(toPublicApp(app)));
});

router.delete("/apps/:id", async (req, res) => {
  const { id } = parseRequest(DeleteAppParams, req.params);
  const [app] = await db.delete(appsTable).where(eq(appsTable.id, id)).returning();
  if (!app) {
    res.status(404).json({ error: "App non trovata" });
    return;
  }
  res.status(204).end();
});

export default router;
