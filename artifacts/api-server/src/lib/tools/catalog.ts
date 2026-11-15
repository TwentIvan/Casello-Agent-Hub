import { db, agentsTable, appsTable, appToolsTable, agentToolsTable, type AppTool } from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { MAX_SUMMARY_CHARS, RECIPIENT_PARAM, SUMMARY_PARAM } from "../agent-loop";
import { logger } from "../logger";
import { parseDefinition } from "./definition";
import { buildComposite } from "./composite";
import { effectiveLevel, type ToolLevel } from "./levels";
import type { AppConnection, CatalogTool, CompositeDefinition } from "./types";

// Oscuramento degli argomenti: modulo puro, usato anche dal ciclo dell'agente
export { maskArgsWithSchema, maskSensitiveArgs, stepArgsWithSchema } from "./sensitive";

// Catalogo dei tool visto dall'orchestratore: quali tool può usare un agente, come
// presentarli al modello (function calling) e come registrarne gli argomenti senza segreti.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converte una riga di `app_tools`; null se la definizione non è più valida. */
export function toCatalogTool(row: AppTool): CatalogTool | null {
  const parsed = parseDefinition(row.kind, row.definition);
  if (!parsed.ok) {
    logger.warn({ toolId: row.id, tool: row.name, error: parsed.error }, "Tool con definizione non valida: escluso");
    return null;
  }
  const schema = isPlainObject(row.paramsSchema) ? row.paramsSchema : { type: "object", properties: {} };
  return { ...row, paramsSchema: schema, definition: parsed.value };
}

// Tool eseguibili dal server: `http`, `mcp` e `composite` (passi `http`/`mcp` della stessa app). I tool `ui` li
// esegue il client che ha avviato la run: si offrono solo alle run avviate con `clientTools` (lib/client-actions.ts).
const EXECUTABLE_KINDS = ["http", "mcp", "composite"] as const;
const WITH_UI_KINDS = [...EXECUTABLE_KINDS, "ui"] as const;

function isOffered(t: { kind: string; level: ToolLevel; levelOverride: ToolLevel | null }, kinds: readonly string[]): boolean {
  return kinds.includes(t.kind) && effectiveLevel(t) !== "L3";
}

/**
 * Tool disponibili per un agente: l'agente `general` usa tutti i tool `active` della sua app,
 * un agente `area` solo quelli collegati in `agent_tools` e `active`. In entrambi i casi solo
 * i tool `http`, `mcp` e `composite` (più i `ui` con `includeUi`) con livello effettivo diverso da L3 (per i
 * composti: il più alto tra il loro e quello dei passi).
 */
export async function loadAgentTools(agentId: number, opts: { includeUi?: boolean } = {}): Promise<CatalogTool[]> {
  const kinds: readonly string[] = opts.includeUi ? WITH_UI_KINDS : EXECUTABLE_KINDS;
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
  if (!agent) throw new Error(`Agente ${agentId} non trovato`);

  let rows: AppTool[];
  if (agent.role === "general") {
    rows = await db
      .select()
      .from(appToolsTable)
      .where(
        and(
          eq(appToolsTable.appId, agent.appId),
          eq(appToolsTable.status, "active"),
          inArray(appToolsTable.kind, [...kinds] as AppTool["kind"][]),
        ),
      )
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
          inArray(appToolsTable.kind, [...kinds] as AppTool["kind"][]),
        ),
      )
      .orderBy(asc(appToolsTable.id));
    rows = linked.map((r) => r.tool);
  }
  const offered = (t: CatalogTool | AppTool) => isOffered(t, kinds);
  const catalog = rows.filter(offered).map(toCatalogTool).filter((t): t is CatalogTool => t !== null);
  // Dopo il collegamento dei passi un composto può essere diventato L3 (un passo vietato): si rifiltra
  return (await resolveCompositeTools(catalog)).filter(offered);
}

/**
 * Collega i tool `composite` ai tool dei loro passi (stessa app, per nome, in qualunque stato: le regole le
 * applica `buildComposite`) e ne alza il livello al più alto dei passi. Un composto con un passo non valido
 * si esclude (con un avviso nel log); gli altri tool restano come sono.
 */
export async function resolveCompositeTools(tools: CatalogTool[]): Promise<CatalogTool[]> {
  const composites = tools.filter((t) => t.kind === "composite");
  if (composites.length === 0) return tools;
  const byApp = new Map<number, Map<string, CatalogTool>>();
  for (const appId of new Set(composites.map((t) => t.appId))) {
    const names = new Set<string>();
    for (const t of composites.filter((c) => c.appId === appId)) {
      for (const step of (t.definition as CompositeDefinition).steps ?? []) names.add(step.tool);
    }
    const rows =
      names.size === 0
        ? []
        : await db
            .select()
            .from(appToolsTable)
            .where(and(eq(appToolsTable.appId, appId), inArray(appToolsTable.name, [...names])));
    const map = new Map<string, CatalogTool>();
    for (const row of rows) {
      const t = toCatalogTool(row);
      if (t) map.set(t.name, t);
    }
    byApp.set(appId, map);
  }
  const out: CatalogTool[] = [];
  for (const t of tools) {
    if (t.kind !== "composite") {
      out.push(t);
      continue;
    }
    const built = buildComposite(t, byApp.get(t.appId) ?? new Map());
    if (built.ok) out.push(built.tool);
    else logger.warn({ toolId: t.id, tool: t.name, error: built.error }, "Tool composto con un passo non valido: escluso");
  }
  return out;
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

// Parametri che Casello aggiunge agli strumenti L2: servono alla coda delle azioni (chi riceve
// l'azione e cosa fa, per chi deve confermarla) e non arrivano mai al servizio
const QUEUE_PARAMS = {
  [RECIPIENT_PARAM]: {
    type: "string",
    description:
      "Chi riceve l'azione o ne subisce l'effetto (persona, squadra, cliente…): lo legge l'utente che deve confermarla.",
  },
  [SUMMARY_PARAM]: {
    type: "string",
    maxLength: MAX_SUMMARY_CHARS,
    description:
      "Sintesi in italiano di cosa farà l'azione, completa e senza segnaposto: l'azione non viene eseguita subito ma va in coda per la conferma dell'utente.",
  },
};

/** Schema offerto al modello per uno strumento L2: quello del tool più destinatario e sintesi obbligatori. */
function withQueueParams(parameters: Record<string, unknown>): Record<string, unknown> {
  const props = isPlainObject(parameters["properties"]) ? parameters["properties"] : {};
  const required = Array.isArray(parameters["required"]) ? (parameters["required"] as unknown[]) : [];
  const extra = Object.keys(QUEUE_PARAMS).filter((name) => !required.includes(name));
  return {
    ...parameters,
    properties: { ...props, ...QUEUE_PARAMS },
    required: [...required, ...extra],
  };
}

export function toFunctionTools(tools: CatalogTool[]): ChatCompletionTool[] {
  // I tool `ui` arrivano qui solo se chi li ha caricati li ha chiesti (run con un client che li esegue)
  return tools.filter((t) => isOffered(t, WITH_UI_KINDS)).map((t) => {
    const parameters = stripExtensions(t.paramsSchema) as Record<string, unknown>;
    return {
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: effectiveLevel(t) === "L2" ? withQueueParams(parameters) : parameters,
      },
    };
  });
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
    mcpUrl: app.mcpUrl,
    extraHeaders: app.extraHeaders,
  };
}
