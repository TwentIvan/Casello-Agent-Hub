import type { Request } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  agentToolsTable,
  appToolsTable,
  type Agent,
  type Analysis,
  type AnalysisItem,
  type App,
  type PlanConversation,
  type PlanMessage,
  type PlanProposal,
  type Run,
} from "@workspace/db";

// Forma pubblica delle risorse: cosa esce dall'API e cosa no.

/** App senza i segreti (servizio e token GitHub): solo l'indicazione che sono impostati. */
export function toPublicApp(app: App) {
  const { serviceSecretEnc, sourceTokenEnc, ...rest } = app;
  return { ...rest, serviceSecretSet: serviceSecretEnc != null, sourceTokenSet: sourceTokenEnc != null };
}

/** Colonna numeric (stringa dal driver) → numero, null se assente o non valida. */
export function toNumberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Argomenti pubblici dell'azione in sospeso: quelli oscurati con lo schema del tool al momento
 * della pausa (`publicArgs`). Senza `publicArgs` (azione salvata prima che esistesse) ogni
 * valore diventa "***": meglio non mostrare che mostrare un segreto.
 */
function publicPendingArgs(p: { args?: unknown; publicArgs?: unknown }): Record<string, unknown> {
  if (isPlainObject(p.publicArgs)) return p.publicArgs;
  if (!isPlainObject(p.args)) return {};
  return Object.fromEntries(Object.keys(p.args).map((k) => [k, "***"]));
}

/**
 * Run senza lo stato del ciclo (`loopState`, contiene la conversazione e gli argomenti) e con
 * l'azione in sospeso ridotta ai campi pubblici (argomenti sensibili oscurati), solo mentre la
 * run è in attesa del client.
 */
export function toPublicRun(run: Run) {
  const { loopState: _loopState, pausedAt: _pausedAt, pendingAction, costUsd, ...rest } = run;
  const p = pendingAction as
    | { kind?: unknown; toolName?: unknown; args?: unknown; publicArgs?: unknown; summary?: unknown }
    | null;
  const publicPending =
    run.status === "awaiting_client" && p && typeof p === "object"
      ? { kind: p.kind, toolName: p.toolName, args: publicPendingArgs(p), summary: p.summary }
      : null;
  return { ...rest, costUsd: toNumberOrNull(costUsd), pendingAction: publicPending };
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

/** Analisi senza log né mappa (elenco e risposta all'avvio): quelli arrivano solo col dettaglio. Mai l'hash della lease. */
export function toPublicAnalysis(analysis: Analysis) {
  const { log: _log, architectureMap: _map, leaseTokenHash: _lease, ...rest } = analysis;
  return { ...rest, costUsd: toNumberOrNull(analysis.costUsd) };
}

/** Dettaglio dell'analisi: con log e mappa, costo come numero, senza l'hash della lease. */
export function toPublicAnalysisDetail(analysis: Analysis) {
  const { leaseTokenHash: _lease, ...rest } = analysis;
  return { ...rest, costUsd: toNumberOrNull(analysis.costUsd) };
}

/**
 * Prove di un elemento nella forma del contratto: la nota è facoltativa nell'esito del modello
 * ma sempre presente in uscita (stringa vuota); voci malformate scartate.
 */
function publicEvidence(evidence: unknown): { source: string; location: string; note: string }[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(isPlainObject).map((e) => ({
    source: typeof e.source === "string" ? e.source : "",
    location: typeof e.location === "string" ? e.location : "",
    note: typeof e.note === "string" ? e.note : "",
  }));
}

/** Elemento della proposta: prove normalizzate, payload sempre un oggetto. */
export function toPublicItem(item: AnalysisItem) {
  const { createdAt: _createdAt, ...rest } = item;
  return {
    ...rest,
    payload: isPlainObject(item.payload) ? item.payload : {},
    evidence: publicEvidence(item.evidence),
  };
}

/** Conversazione del piano: senza l'utente proprietario, costo come numero (null = parziale). */
export function toPublicPlanConversation(conv: PlanConversation) {
  const { userId: _userId, costUsd, ...rest } = conv;
  return { ...rest, costUsd: toNumberOrNull(costUsd) };
}

/** Messaggio della conversazione, senza il conteggio dei token. */
export function toPublicPlanMessage(message: PlanMessage) {
  const { conversationId: _conversationId, tokens: _tokens, ...rest } = message;
  return rest;
}

/**
 * Proposta del bot con il titolo già calcolato (`title`: della voce proposta o, per discard, di quella di
 * destinazione, passato dal chiamante). Mai l'impronta della voce di destinazione.
 */
export function toPublicPlanProposal(proposal: PlanProposal, title: string) {
  const { conversationId: _conversationId, targetHash: _targetHash, ...rest } = proposal;
  return { ...rest, title, payload: isPlainObject(proposal.payload) ? proposal.payload : null };
}
