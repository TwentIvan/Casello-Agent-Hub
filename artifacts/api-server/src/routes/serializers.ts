import type { Request } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, agentToolsTable, appToolsTable, type Agent, type App, type Run } from "@workspace/db";

// Forma pubblica delle risorse: cosa esce dall'API e cosa no.

/** App senza il segreto di servizio: solo l'indicazione che è impostato. */
export function toPublicApp(app: App) {
  const { serviceSecretEnc, ...rest } = app;
  return { ...rest, serviceSecretSet: serviceSecretEnc != null };
}

/**
 * Run senza lo stato del ciclo (`loopState`, contiene la conversazione e gli argomenti) e con
 * l'azione in sospeso ridotta ai campi pubblici, solo mentre la run è in attesa del client.
 */
export function toPublicRun(run: Run) {
  const { loopState: _loopState, pausedAt: _pausedAt, pendingAction, ...rest } = run;
  const p = pendingAction as { kind?: unknown; toolName?: unknown; args?: unknown; summary?: unknown } | null;
  const publicPending =
    run.status === "awaiting_client" && p && typeof p === "object"
      ? { kind: p.kind, toolName: p.toolName, args: p.args, summary: p.summary }
      : null;
  return { ...rest, pendingAction: publicPending };
}

/**
 * ID dei tool di ciascun agente, ordinati: per l'agente `general` i tool `active` della sua app
 * (gli stessi che usa in esecuzione), per gli agenti `area` quelli collegati in `agent_tools`.
 */
export async function toolIdsByAgent(agents: Agent[]): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>(agents.map((a) => [a.id, []]));
  const areaIds = agents.filter((a) => a.role !== "general").map((a) => a.id);
  const generalAppIds = [...new Set(agents.filter((a) => a.role === "general").map((a) => a.appId))];

  if (areaIds.length) {
    const links = await db
      .select()
      .from(agentToolsTable)
      .where(inArray(agentToolsTable.agentId, areaIds))
      .orderBy(asc(agentToolsTable.toolId));
    for (const link of links) result.get(link.agentId)!.push(link.toolId);
  }
  if (generalAppIds.length) {
    const tools = await db
      .select({ id: appToolsTable.id, appId: appToolsTable.appId })
      .from(appToolsTable)
      .where(and(inArray(appToolsTable.appId, generalAppIds), eq(appToolsTable.status, "active")))
      .orderBy(asc(appToolsTable.id));
    for (const agent of agents.filter((a) => a.role === "general")) {
      result.set(
        agent.id,
        tools.filter((t) => t.appId === agent.appId).map((t) => t.id),
      );
    }
  }
  return result;
}

export async function withToolIds(agents: Agent[]) {
  const ids = await toolIdsByAgent(agents);
  return agents.map((a) => ({ ...a, toolIds: ids.get(a.id) ?? [] }));
}

export async function withToolIdsOne(agent: Agent) {
  const [result] = await withToolIds([agent]);
  return result!;
}

/**
 * Token dell'utente finale dall'header X-App-User-Token (vuoto = assente). Resta solo in memoria
 * per la durata della run: mai salvato né scritto nei log (pino-http registra solo metodo e URL).
 */
export function userTokenFrom(req: Request): string | undefined {
  const value = req.get("x-app-user-token")?.trim();
  return value ? value : undefined;
}
