import { asc, eq, inArray, and } from "drizzle-orm";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { db, appToolsTable } from "@workspace/db";
import { enqueueAction } from "../actions/queue";
import { QUEUE_FAILED, type LoopDeps } from "../agent-loop";
import { logger } from "../logger";
import { loadAppConnection, toCatalogTool, toFunctionTools } from "../tools/catalog";
import { executeTool } from "../tools/executor";
import { effectiveLevel } from "../tools/levels";
import type { AppConnection, CatalogTool, ToolResult } from "../tools/types";

// Strumenti dei ruoli di una squadra: `app_tools` di più app (ognuno con la connessione della sua app) più gli
// strumenti interni della squadra, gestiti dal motore e mai da `executeTool`. Il nome esposto al modello è il nome
// del tool se unico tra quelli del ruolo e diverso dagli strumenti interni, altrimenti `<nome>_<appId>`: la mappa
// `nameMap` riporta ogni nome esposto al tool del catalogo (e quindi alla sua app).

export const INTERNAL_TOOL_NAMES = [
  "riferisci",
  "leggi_piano",
  "proponi_piano",
  "aggiorna_piano",
  "assegna_compito",
  "leggi_esito",
  "segnala",
  "chiudi_lavoro",
  // Run degli agenti di area (escalation.ts), non delle squadre
  "segnala_al_responsabile",
] as const;

export type InternalToolName = (typeof INTERNAL_TOOL_NAMES)[number];

/** Tipo degli strumenti interni: non è un `kind` di `app_tools`, lo riconosce solo il motore della squadra. */
export const INTERNAL_KIND = "internal";

const MAX_TOOL_NAME = 64;
const INTERNAL = new Set<string>(INTERNAL_TOOL_NAMES);
const EXECUTABLE_KINDS = ["http", "mcp"] as const;

export interface RoleTools {
  /** Tool delle app con il nome esposto al modello */
  tools: CatalogTool[];
  /** Connessione di ogni app dei tool, per id dell'app */
  connections: Map<number, AppConnection>;
  /** Nome esposto → tool del catalogo (con il suo nome originale) */
  nameMap: Map<string, CatalogTool>;
}

function withSuffix(name: string, suffix: string): string {
  return name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
}

/**
 * Tool del ruolo: solo `active`, `http`/`mcp`, livello effettivo diverso da L3 e con definizione valida, in
 * ordine di id. Nomi esposti distinti tra loro e dagli strumenti interni.
 */
export async function loadRoleTools(toolIds: number[]): Promise<RoleTools> {
  const rows =
    toolIds.length === 0
      ? []
      : await db
          .select()
          .from(appToolsTable)
          .where(and(inArray(appToolsTable.id, toolIds), eq(appToolsTable.status, "active"), inArray(appToolsTable.kind, [...EXECUTABLE_KINDS])))
          .orderBy(asc(appToolsTable.id));
  const catalog = rows
    .filter((r) => effectiveLevel(r) !== "L3")
    .map(toCatalogTool)
    .filter((t): t is CatalogTool => t !== null);

  const counts = new Map<string, number>();
  for (const t of catalog) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

  const tools: CatalogTool[] = [];
  const nameMap = new Map<string, CatalogTool>();
  for (const t of catalog) {
    let exposed = counts.get(t.name) === 1 && !INTERNAL.has(t.name) ? t.name : withSuffix(t.name, `_${t.appId}`);
    // Difesa: un nome con suffisso può coincidere con il nome di un altro tool del ruolo
    if (nameMap.has(exposed) || INTERNAL.has(exposed)) exposed = withSuffix(t.name, `_${t.appId}_${t.id}`);
    nameMap.set(exposed, t);
    tools.push({ ...t, name: exposed });
  }

  const appIds = [...new Set(catalog.map((t) => t.appId))];
  const connections = new Map<number, AppConnection>();
  for (const appId of appIds) connections.set(appId, await loadAppConnection(appId));
  return { tools, connections, nameMap };
}

/** Strumento interno sintetico (livello L1, eseguito in sequenza): lo gestisce solo il motore della squadra. */
export function internalTool(name: InternalToolName, description: string, paramsSchema: Record<string, unknown>): CatalogTool {
  const now = new Date(0);
  return {
    id: 0,
    appId: 0,
    name,
    description,
    kind: INTERNAL_KIND as CatalogTool["kind"],
    identity: "service",
    level: "L1",
    levelOverride: null,
    status: "active",
    paramsSchema,
    definition: { action: name },
    evidence: null,
    needsVerification: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function isInternalTool(tool: CatalogTool): boolean {
  return (tool.kind as string) === INTERNAL_KIND;
}

/** Strumenti offerti al modello: quelli delle app (con i parametri della coda per gli L2) più quelli interni. */
export function roleFunctionTools(appTools: CatalogTool[], internal: CatalogTool[]): ChatCompletionTool[] {
  return [
    ...toFunctionTools(appTools),
    ...internal.map((t) => ({
      type: "function" as const,
      function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.paramsSchema },
    })),
  ];
}

export type InternalHandler = (tool: CatalogTool, args: Record<string, unknown>) => Promise<ToolResult>;

const UNKNOWN_TOOL: ToolResult = { ok: false, content: "strumento non disponibile" };

/**
 * `LoopDeps["executeTool"]` per un ruolo: gli strumenti interni vanno a `internal`, quelli delle app al tool del
 * catalogo mappato dal nome esposto, con la connessione della sua app. Nessun token utente: le squadre usano solo
 * l'identità di servizio (un tool `user` risponde «token utente mancante»).
 */
export function roleToolExecutor(role: RoleTools, internal: InternalHandler, signal?: AbortSignal): LoopDeps["executeTool"] {
  return async (tool, args) => {
    if (isInternalTool(tool)) return internal(tool, args);
    const target = role.nameMap.get(tool.name);
    const conn = target ? role.connections.get(target.appId) : undefined;
    if (!target || !conn) return UNKNOWN_TOOL;
    return executeTool({ conn, tool: target, args, ...(signal ? { signal } : {}) });
  };
}

/**
 * `LoopDeps["queueAction"]` per una squadra: la voce va all'utente che ha attivato la squadra, con l'app del tool
 * mappato e `team_instance_id`. Un errore diventa il messaggio fisso QUEUE_FAILED (nel log solo il tipo).
 */
export function teamQueueAction(role: RoleTools, input: { instanceId: number; userId: number }): LoopDeps["queueAction"] {
  return async (tool, args, recipient, summary) => {
    const target = role.nameMap.get(tool.name);
    if (!target) return { ok: false, message: QUEUE_FAILED };
    try {
      return await enqueueAction({
        userId: input.userId,
        appId: target.appId,
        agentId: null,
        runId: null,
        tool: target,
        args,
        recipient,
        summary,
        teamInstanceId: input.instanceId,
      });
    } catch (err) {
      logger.error({ instanceId: input.instanceId, errName: err instanceof Error ? err.name : typeof err }, "Accodamento dell'azione della squadra non riuscito");
      return { ok: false, message: QUEUE_FAILED };
    }
  };
}

/** Schema dei parametri per nome esposto (per oscurare gli argomenti nei passi); null se lo strumento non esiste. */
export function toolSchemaLookup(tools: CatalogTool[]): (toolName: string) => unknown | null {
  const byName = new Map(tools.map((t) => [t.name, t.paramsSchema]));
  return (toolName) => byName.get(toolName) ?? null;
}
