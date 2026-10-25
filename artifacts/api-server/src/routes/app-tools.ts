import { Router, type IRouter, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, appsTable, appToolsTable } from "@workspace/db";
import {
  ListAppToolsParams,
  ListAppToolsResponse,
  CreateAppToolParams,
  CreateAppToolBody,
  CreateAppToolResponse,
  UpdateAppToolParams,
  UpdateAppToolBody,
  UpdateAppToolResponse,
  DeleteAppToolParams,
} from "@workspace/api-zod";
import { checkParamsSchema, checkPathPlaceholders, parseDefinition } from "../lib/tools/definition";
import type { HttpDefinition, ToolKind } from "../lib/tools/types";
import { isUniqueViolation } from "./serializers";

// Catalogo dei tool di un'app: i tool appartengono all'app e si assegnano agli agenti con
// PUT /agents/:id/tools.

const router: IRouter = Router();

// Il nome diventa il nome della function del modello: stesse regole dei provider
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_PARAMS_SCHEMA = { type: "object", properties: {} };
const DUPLICATE_NAME = "Esiste già uno strumento con questo nome nell'app";

/** Errore di validazione in italiano, o null se nome, definizione e schema sono coerenti. */
function validateTool(name: string, kind: ToolKind, definition: unknown, paramsSchema: unknown): string | null {
  if (!TOOL_NAME.test(name)) {
    return "nome non valido: da 1 a 64 caratteri tra lettere, cifre, '_' e '-'";
  }
  const parsed = parseDefinition(kind, definition);
  if (!parsed.ok) return parsed.error;
  const schemaError = checkParamsSchema(paramsSchema);
  if (schemaError) return schemaError;
  if (kind === "http") return checkPathPlaceholders(parsed.value as HttpDefinition, paramsSchema as object);
  return null;
}

async function appExists(id: number): Promise<boolean> {
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
  return !!app;
}

function appNotFound(res: Response) {
  res.status(404).json({ error: "App non trovata" });
}

router.get("/apps/:id/tools", async (req, res) => {
  const { id } = ListAppToolsParams.parse(req.params);
  if (!(await appExists(id))) return appNotFound(res);
  const tools = await db.select().from(appToolsTable).where(eq(appToolsTable.appId, id)).orderBy(asc(appToolsTable.id));
  res.json(ListAppToolsResponse.parse(tools));
});

router.post("/apps/:id/tools", async (req, res) => {
  const { id } = CreateAppToolParams.parse(req.params);
  const body = CreateAppToolBody.parse(req.body);
  if (!(await appExists(id))) return appNotFound(res);

  const paramsSchema = body.paramsSchema ?? DEFAULT_PARAMS_SCHEMA;
  const error = validateTool(body.name, body.kind, body.definition, paramsSchema);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  try {
    const [tool] = await db
      .insert(appToolsTable)
      .values({ ...body, paramsSchema, appId: id })
      .returning();
    res.status(201).json(CreateAppToolResponse.parse(tool));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    res.status(409).json({ error: DUPLICATE_NAME });
  }
});

router.patch("/apps/:id/tools/:toolId", async (req, res) => {
  const { id, toolId } = UpdateAppToolParams.parse(req.params);
  const body = UpdateAppToolBody.parse(req.body);
  const [current] = await db
    .select()
    .from(appToolsTable)
    .where(and(eq(appToolsTable.id, toolId), eq(appToolsTable.appId, id)))
    .limit(1);
  if (!current) {
    res.status(404).json({ error: "Strumento non trovato" });
    return;
  }

  // Si valida il tool risultante: cambiare solo kind, definizione o schema deve restare coerente
  const error = validateTool(
    body.name ?? current.name,
    body.kind ?? current.kind,
    body.definition ?? current.definition,
    body.paramsSchema ?? current.paramsSchema,
  );
  if (error) {
    res.status(400).json({ error });
    return;
  }

  try {
    const [tool] = await db
      .update(appToolsTable)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(appToolsTable.id, toolId), eq(appToolsTable.appId, id)))
      .returning();
    if (!tool) {
      res.status(404).json({ error: "Strumento non trovato" });
      return;
    }
    res.json(UpdateAppToolResponse.parse(tool));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    res.status(409).json({ error: DUPLICATE_NAME });
  }
});

router.delete("/apps/:id/tools/:toolId", async (req, res) => {
  const { id, toolId } = DeleteAppToolParams.parse(req.params);
  const [tool] = await db
    .delete(appToolsTable)
    .where(and(eq(appToolsTable.id, toolId), eq(appToolsTable.appId, id)))
    .returning();
  if (!tool) {
    res.status(404).json({ error: "Strumento non trovato" });
    return;
  }
  res.status(204).end();
});

export default router;
