import { Router, type IRouter, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, agentTriggersTable, appsTable, appToolsTable, pendingActionStepsTable, pendingActionsTable } from "@workspace/db";
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
  RefreshAppMcpToolsParams,
  RefreshAppMcpToolsResponse,
} from "@workspace/api-zod";
import { TOOL_NAME, checkParamsSchema, checkPathPlaceholders, parseDefinition } from "../lib/tools/definition";
import { isValidOverride, type ToolLevel } from "../lib/tools/levels";
import type { HttpDefinition, ToolKind } from "../lib/tools/types";
import { isForeignKeyViolation, isUniqueViolation } from "../lib/pg-errors";
import { loadAppConnection } from "../lib/tools/catalog";
import { McpError, listMcpTools } from "../lib/tools/mcp-client";
import { syncMcpTools } from "../lib/tools/mcp-sync";
import { mcpRefreshRateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";
import { TRIGGER_MESSAGES } from "../lib/triggers/messages";

// Catalogo dei tool di un'app: i tool appartengono all'app e si assegnano agli agenti con
// PUT /agents/:id/tools.

const TOOL_HAS_ACTIONS = "il tool ha azioni in coda o già decise: disattivalo invece di eliminarlo";
const TRIGGER_TOOL_FK = "agent_triggers_tool_id_app_tools_id_fk";

const router: IRouter = Router();

const DEFAULT_PARAMS_SCHEMA = { type: "object", properties: {} };
const OVERRIDE_ONLY_RAISES = "il livello può solo essere alzato";
const MCP_LEVEL_READ_ONLY = "il livello dei tool MCP è dichiarato dal servizio";
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

/** Regole sui livelli: `level` dei tool MCP solo dal servizio, deroga mai sotto il livello. */
function validateLevels(
  kind: ToolKind,
  body: { level?: ToolLevel; levelOverride?: ToolLevel | null },
  current: { level: ToolLevel; levelOverride: ToolLevel | null } | null,
): string | null {
  if (kind === "mcp" && body.level !== undefined) return MCP_LEVEL_READ_ONLY;
  const declared = body.level ?? current?.level ?? "L2";
  const override = body.levelOverride !== undefined ? body.levelOverride : (current?.levelOverride ?? null);
  return isValidOverride(declared, override) ? null : OVERRIDE_ONLY_RAISES;
}

async function appExists(id: number): Promise<boolean> {
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, id)).limit(1);
  return !!app;
}

function appNotFound(res: Response) {
  res.status(404).json({ error: "App non trovata" });
}

router.get("/apps/:id/tools", async (req, res) => {
  const { id } = parseRequest(ListAppToolsParams, req.params);
  if (!(await appExists(id))) return appNotFound(res);
  const tools = await db.select().from(appToolsTable).where(eq(appToolsTable.appId, id)).orderBy(asc(appToolsTable.id));
  res.json(ListAppToolsResponse.parse(tools));
});

router.post("/apps/:id/tools", async (req, res) => {
  const { id } = parseRequest(CreateAppToolParams, req.params);
  const body = parseRequest(CreateAppToolBody, req.body);
  if (!(await appExists(id))) return appNotFound(res);

  const paramsSchema = body.paramsSchema ?? DEFAULT_PARAMS_SCHEMA;
  const error = validateTool(body.name, body.kind, body.definition, paramsSchema) ?? validateLevels(body.kind, body, null);
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
    if (!isUniqueViolation(err, "app_tools_app_id_name_unique")) throw err;
    res.status(409).json({ error: DUPLICATE_NAME });
  }
});

// Rilegge gli strumenti del server MCP dell'app e allinea il catalogo
router.post("/apps/:id/mcp-tools/refresh", mcpRefreshRateLimit, async (req, res) => {
  const { id } = parseRequest(RefreshAppMcpToolsParams, req.params);
  if (!(await appExists(id))) return appNotFound(res);
  const conn = await loadAppConnection(id);
  if (!conn.mcpUrl) {
    res.status(409).json({ error: "l'app non ha un server MCP" });
    return;
  }
  try {
    const tools = await listMcpTools(conn);
    res.json(RefreshAppMcpToolsResponse.parse(await syncMcpTools(id, tools)));
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    res.status(502).json({ error: err.message });
  }
});

router.patch("/apps/:id/tools/:toolId", async (req, res) => {
  const { id, toolId } = parseRequest(UpdateAppToolParams, req.params);
  const body = parseRequest(UpdateAppToolBody, req.body);
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
  const kind = body.kind ?? current.kind;
  // Diventando MCP il livello scelto a mano non vale più: L2 (come un tool MCP nuovo) e niente deroga,
  // finché la sincronizzazione successiva non porta il livello dichiarato dal servizio
  const toMcp = kind === "mcp" && current.kind !== "mcp";
  const levels = toMcp ? { level: "L2" as const, levelOverride: body.levelOverride ?? null } : {};
  const error =
    validateTool(
      body.name ?? current.name,
      kind,
      body.definition ?? current.definition,
      body.paramsSchema ?? current.paramsSchema,
    ) ?? validateLevels(kind, body, toMcp ? { level: "L2", levelOverride: null } : current);
  if (error) {
    res.status(400).json({ error });
    return;
  }

  try {
    const [tool] = await db
      .update(appToolsTable)
      .set({ ...body, ...levels, updatedAt: new Date() })
      .where(and(eq(appToolsTable.id, toolId), eq(appToolsTable.appId, id)))
      .returning();
    if (!tool) {
      res.status(404).json({ error: "Strumento non trovato" });
      return;
    }
    res.json(UpdateAppToolResponse.parse(tool));
  } catch (err) {
    if (!isUniqueViolation(err, "app_tools_app_id_name_unique")) throw err;
    res.status(409).json({ error: DUPLICATE_NAME });
  }
});

router.delete("/apps/:id/tools/:toolId", async (req, res) => {
  const { id, toolId } = parseRequest(DeleteAppToolParams, req.params);
  const [exists] = await db
    .select({ id: appToolsTable.id })
    .from(appToolsTable)
    .where(and(eq(appToolsTable.id, toolId), eq(appToolsTable.appId, id)))
    .limit(1);
  if (!exists) {
    res.status(404).json({ error: "Strumento non trovato" });
    return;
  }
  // Lo storico delle approvazioni non si perde: un tool con azioni in coda o già decise si disattiva
  const [queued] = await db
    .select({ id: pendingActionsTable.id })
    .from(pendingActionsTable)
    .where(eq(pendingActionsTable.toolId, toolId))
    .limit(1);
  // Vale anche per un passo di una proposta, in coda o già decisa (FK RESTRICT)
  const [inStep] = await db
    .select({ id: pendingActionStepsTable.id })
    .from(pendingActionStepsTable)
    .where(eq(pendingActionStepsTable.toolId, toolId))
    .limit(1);
  if (queued || inStep) {
    res.status(409).json({ error: TOOL_HAS_ACTIONS });
    return;
  }
  // Un innesco di sorveglianza lo chiama a ogni giro (FK RESTRICT): si elimina prima l'innesco
  const [usedBy] = await db
    .select({ id: agentTriggersTable.id })
    .from(agentTriggersTable)
    .where(eq(agentTriggersTable.toolId, toolId))
    .limit(1);
  if (usedBy) {
    res.status(409).json({ error: TRIGGER_MESSAGES.toolInUse });
    return;
  }
  let tool;
  try {
    [tool] = await db
      .delete(appToolsTable)
      .where(and(eq(appToolsTable.id, toolId), eq(appToolsTable.appId, id)))
      .returning();
  } catch (err) {
    // Un'azione o un innesco sono arrivati tra il controllo e la cancellazione (FK RESTRICT)
    if (!isForeignKeyViolation(err)) throw err;
    res.status(409).json({ error: isForeignKeyViolation(err, TRIGGER_TOOL_FK) ? TRIGGER_MESSAGES.toolInUse : TOOL_HAS_ACTIONS });
    return;
  }
  if (!tool) {
    res.status(404).json({ error: "Strumento non trovato" });
    return;
  }
  res.status(204).end();
});

export default router;
