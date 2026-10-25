import { db, agentsTable, appsTable, appToolsTable, agentToolsTable, type AppTool } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { logger } from "../logger";
import { parseDefinition } from "./definition";
import type { AppConnection, CatalogTool } from "./types";

// Catalogo dei tool visto dall'orchestratore: quali tool può usare un agente, come
// presentarli al modello (function calling) e come registrarne gli argomenti senza segreti.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converte una riga di `app_tools`; null se la definizione non è più valida. */
function toCatalogTool(row: AppTool): CatalogTool | null {
  const parsed = parseDefinition(row.kind, row.definition);
  if (!parsed.ok) {
    logger.warn({ toolId: row.id, tool: row.name, error: parsed.error }, "Tool con definizione non valida: escluso");
    return null;
  }
  const schema = isPlainObject(row.paramsSchema) ? row.paramsSchema : { type: "object", properties: {} };
  return { ...row, paramsSchema: schema, definition: parsed.value };
}

/**
 * Tool disponibili per un agente: l'agente `general` usa tutti i tool `active` della sua app,
 * un agente `area` solo quelli collegati in `agent_tools` e `active`.
 */
export async function loadAgentTools(agentId: number): Promise<CatalogTool[]> {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
  if (!agent) throw new Error(`Agente ${agentId} non trovato`);

  let rows: AppTool[];
  if (agent.role === "general") {
    rows = await db
      .select()
      .from(appToolsTable)
      .where(and(eq(appToolsTable.appId, agent.appId), eq(appToolsTable.status, "active")))
      .orderBy(asc(appToolsTable.id));
  } else {
    const linked = await db
      .select({ tool: appToolsTable })
      .from(agentToolsTable)
      .innerJoin(appToolsTable, eq(agentToolsTable.toolId, appToolsTable.id))
      .where(
        and(
          eq(agentToolsTable.agentId, agentId),
          // Difesa: un collegamento verso il tool di un'altra app non conta
          eq(appToolsTable.appId, agent.appId),
          eq(appToolsTable.status, "active"),
        ),
      )
      .orderBy(asc(appToolsTable.id));
    rows = linked.map((r) => r.tool);
  }
  return rows.map(toCatalogTool).filter((t): t is CatalogTool => t !== null);
}

/** Copia dello schema senza le estensioni `x-*` (es. x-sensitive), che alcuni provider rifiutano. */
function stripExtensions(node: unknown, isPropertiesMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => stripExtensions(n));
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Dentro `properties` le chiavi sono nomi di parametri, non parole chiave
    if (!isPropertiesMap && key.startsWith("x-")) continue;
    out[key] = stripExtensions(value, !isPropertiesMap && (key === "properties" || key === "patternProperties"));
  }
  return out;
}

export function toFunctionTools(tools: CatalogTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: stripExtensions(t.paramsSchema) as Record<string, unknown>,
    },
  }));
}

function isSensitive(schema: unknown): boolean {
  return isPlainObject(schema) && schema["x-sensitive"] === true;
}

function hasSensitive(schema: unknown): boolean {
  if (isSensitive(schema)) return true;
  if (!isPlainObject(schema)) return false;
  const props = schema["properties"];
  return isPlainObject(props) && Object.values(props).some(hasSensitive);
}

function maskWith(schema: unknown, value: unknown): unknown {
  if (isSensitive(schema)) return "***";
  if (!isPlainObject(schema)) return value;
  const props = schema["properties"];
  if (!isPlainObject(props)) return value;
  if (!isPlainObject(value)) return hasSensitive(schema) ? "***" : value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = Object.hasOwn(props, key) ? maskWith(props[key], v) : v;
  }
  return out;
}

/**
 * Argomenti pronti per `run_steps`: le proprietà con `"x-sensitive": true` diventano "***"
 * (anche annidate). Argomenti che non sono un oggetto (es. JSON non valido) vengono oscurati
 * per intero se lo schema ha proprietà sensibili. Non modifica il valore ricevuto.
 */
export function maskSensitiveArgs(tool: CatalogTool, args: unknown): unknown {
  return maskWith(tool.paramsSchema, args);
}

/** Come maskSensitiveArgs, a partire dal solo schema dei parametri (es. riga di un tool non più attivo). */
export function maskArgsWithSchema(paramsSchema: unknown, args: unknown): unknown {
  return maskWith(paramsSchema, args);
}

const RAW_ARGS_CHARS = 500;

/**
 * Argomenti pronti per `run_steps.args`, sempre un oggetto (il contratto vuole object|null):
 * un oggetto viene oscurato come in maskSensitiveArgs; qualunque altro valore (JSON non valido,
 * array, stringa…) diventa `{ "_raw": "<testo troncato a 500 caratteri>" }`, oppure
 * `{ "_raw": "***" }` se lo schema ha proprietà sensibili.
 */
export function stepArgsWithSchema(paramsSchema: unknown, args: unknown): Record<string, unknown> {
  if (isPlainObject(args)) return maskWith(paramsSchema, args) as Record<string, unknown>;
  if (hasSensitive(paramsSchema)) return { _raw: "***" };
  const text = typeof args === "string" ? args : (JSON.stringify(args) ?? String(args));
  return { _raw: text.slice(0, RAW_ARGS_CHARS) };
}

export async function loadAppConnection(appId: number): Promise<AppConnection> {
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId)).limit(1);
  if (!app) throw new Error(`App ${appId} non trovata`);
  return {
    baseUrl: app.baseUrl,
    internalBaseUrl: app.internalBaseUrl,
    userAuth: app.userAuth,
    serviceAuth: app.serviceAuth,
    serviceSecretEnc: app.serviceSecretEnc,
  };
}
