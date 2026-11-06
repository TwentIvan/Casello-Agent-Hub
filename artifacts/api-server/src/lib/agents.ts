// Scritture sugli agenti condivise dalle route (`/api/agents`) e dalle schede di Lucius: stesse regole e stessi
// messaggi. Ogni funzione accetta un `executor`: con una transazione aperta le scritture (e le letture di controllo)
// passano da quella; le transazioni interne diventano savepoint.

import { and, eq, inArray } from "drizzle-orm";
import { db, agentToolsTable, agentsTable, appToolsTable, appsTable, type Agent } from "@workspace/db";
import type { ModelChoice } from "./ai/choice";

export const AGENT_MESSAGES = {
  notFound: "Agente non trovato",
  appNotFound: "App non trovata",
  generalTools: "L'agente generale usa tutti i tool attivi dell'app: non gli si assegnano tool",
  toolsNotOwned: "Alcuni strumenti non esistono o non appartengono all'app dell'agente",
} as const;

export class AgentError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export type AgentExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "transaction">;

/** Aggiorna i campi dati dell'agente (e `updatedAt`). Agente inesistente → 404. */
export async function updateAgent(
  agentId: number,
  set: Partial<Omit<typeof agentsTable.$inferInsert, "id" | "createdAt" | "updatedAt">>,
  executor: AgentExecutor = db,
): Promise<Agent> {
  const [agent] = await executor
    .update(agentsTable)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(agentsTable.id, agentId))
    .returning();
  if (!agent) throw new AgentError(404, AGENT_MESSAGES.notFound);
  return agent;
}

/** Prompt di sistema dell'agente, come `PATCH /api/agents/:id` con il solo `systemPrompt`. */
export function updateAgentPrompt(agentId: number, systemPrompt: string | null, executor: AgentExecutor = db): Promise<Agent> {
  return updateAgent(agentId, { systemPrompt }, executor);
}

/**
 * Tool collegati a un agente di area (sostituisce l'elenco), come `PUT /api/agents/:id/tools`: id ripetuti tolti,
 * agente generale → 400, tool che non esistono o non sono dell'app dell'agente → 400.
 */
export async function setAgentTools(agentId: number, toolIds: number[], executor: AgentExecutor = db): Promise<Agent> {
  const ids = [...new Set(toolIds)];
  const [agent] = await executor.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1);
  if (!agent) throw new AgentError(404, AGENT_MESSAGES.notFound);
  if (agent.role === "general") throw new AgentError(400, AGENT_MESSAGES.generalTools);
  if (ids.length) {
    const owned = await executor
      .select({ id: appToolsTable.id })
      .from(appToolsTable)
      .where(and(eq(appToolsTable.appId, agent.appId), inArray(appToolsTable.id, ids)));
    if (owned.length !== ids.length) throw new AgentError(400, AGENT_MESSAGES.toolsNotOwned);
  }
  return executor.transaction(async (tx) => {
    await tx.delete(agentToolsTable).where(eq(agentToolsTable.agentId, agentId));
    if (ids.length) await tx.insert(agentToolsTable).values(ids.map((toolId) => ({ agentId, toolId })));
    const [row] = await tx.update(agentsTable).set({ updatedAt: new Date() }).where(eq(agentsTable.id, agentId)).returning();
    return row!;
  });
}

/**
 * Agente di area nuovo, come `POST /api/agents` (il generale nasce con l'app). Il modello lo sceglie chi chiama
 * (`resolveAgentModel`, letto dal pool prima di un'eventuale transazione). App inesistente → 404.
 */
export async function createAreaAgent(
  input: { appId: number; name: string; systemPrompt?: string; status?: Agent["status"] },
  choice: ModelChoice,
  executor: AgentExecutor = db,
): Promise<Agent> {
  const [app] = await executor.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, input.appId)).limit(1);
  if (!app) throw new AgentError(404, AGENT_MESSAGES.appNotFound);
  const [agent] = await executor
    .insert(agentsTable)
    .values({ ...input, ...choice, role: "area" })
    .returning();
  return agent!;
}
