// Registrazione dell'esito di una fase dell'architetto: lo trasforma negli elementi della proposta
// (`analysis_items`) con le differenze rispetto allo stato attuale dell'app. Condivisa tra l'esecutore
// cloud (run-analysis) e quello locale, così gli esiti si registrano allo stesso modo.

import { eq, inArray, max } from "drizzle-orm";
import {
  db,
  agentSkillsTable,
  agentToolsTable,
  agentsTable,
  analysisItemsTable,
  appToolsTable,
} from "@workspace/db";
import { diffAgents, diffAlwaysNew, diffSkills, diffTools, type DiffEntry } from "./diff";
import type {
  AgentsResult,
  AnalysisChapter,
  CatalogResult,
  CompletionResult,
  EvolutionResult,
  PhaseName,
} from "./schemas";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

// --- Stato attuale dell'app, per le differenze -------------------------------------------------
// Letto con lo stesso esecutore della scrittura: dentro una transazione si legge dalla transazione

async function currentTools(appId: number, executor: Executor) {
  return executor.select().from(appToolsTable).where(eq(appToolsTable.appId, appId));
}

async function currentAgents(appId: number, executor: Executor) {
  const agents = await executor.select().from(agentsTable).where(eq(agentsTable.appId, appId));
  if (agents.length === 0) return [];
  const links = await executor
    .select({ agentId: agentToolsTable.agentId, name: appToolsTable.name })
    .from(agentToolsTable)
    .innerJoin(appToolsTable, eq(agentToolsTable.toolId, appToolsTable.id))
    .where(inArray(agentToolsTable.agentId, agents.map((a) => a.id)));
  return agents.map((a) => ({ ...a, toolNames: links.filter((l) => l.agentId === a.id).map((l) => l.name) }));
}

async function currentSkills(appId: number, executor: Executor) {
  const rows = await executor
    .select({ skill: agentSkillsTable, agentRole: agentsTable.role, agentArea: agentsTable.area })
    .from(agentSkillsTable)
    .innerJoin(agentsTable, eq(agentSkillsTable.agentId, agentsTable.id))
    .where(eq(agentsTable.appId, appId));
  return rows.map((r) => ({ ...r.skill, agentRole: r.agentRole as string, agentArea: r.agentArea }));
}

type ChapterEntries = { chapter: AnalysisChapter; entries: DiffEntry<unknown>[] };

/** Elementi di una fase, calcolati rispetto allo stato attuale del DB. */
async function phaseItems(phase: PhaseName, result: unknown, appId: number, executor: Executor): Promise<ChapterEntries[]> {
  switch (phase) {
    case "catalog": {
      const r = result as CatalogResult;
      return [
        { chapter: "tool", entries: diffTools(r.tools, await currentTools(appId, executor)) },
        { chapter: "endpoint", entries: diffAlwaysNew({ chapter: "endpoint", items: r.endpoints }) },
      ];
    }
    case "agents": {
      const r = result as AgentsResult;
      return [
        { chapter: "agent", entries: diffAgents(r.agents, await currentAgents(appId, executor)) },
        { chapter: "skill", entries: diffSkills(r.skills, await currentSkills(appId, executor)) },
      ];
    }
    case "completion":
      return [{ chapter: "completion", entries: diffAlwaysNew({ chapter: "completion", items: (result as CompletionResult).items }) }];
    case "evolution":
      return [{ chapter: "evolution", entries: diffAlwaysNew({ chapter: "evolution", items: (result as EvolutionResult).items }) }];
    default:
      return [];
  }
}

function evidenceOf(payload: unknown): unknown[] {
  const ev = (payload as { evidence?: unknown } | null)?.evidence;
  return Array.isArray(ev) ? ev : [];
}

/**
 * Registra l'esito di una fase: calcola gli elementi, li inserisce con un'unica INSERT e fa proseguire
 * `position` da quella massima dell'analisi. Restituisce quanti elementi ha inserito. Con `executor`
 * si può usare dentro una transazione.
 */
export async function recordPhaseResult(
  input: { analysisId: number; appId: number; phase: PhaseName; result: unknown },
  executor: Executor = db,
): Promise<number> {
  const { analysisId, appId, phase, result } = input;
  const groups = await phaseItems(phase, result, appId, executor);
  const entries = groups.flatMap(({ chapter, entries }) => entries.map((e) => ({ chapter, e })));
  if (entries.length === 0) return 0;
  const [last] = await executor
    .select({ value: max(analysisItemsTable.position) })
    .from(analysisItemsTable)
    .where(eq(analysisItemsTable.analysisId, analysisId));
  let position = last?.value ?? 0;
  const rows = entries.map(({ chapter, e }) => ({
    analysisId,
    chapter,
    ref: e.ref,
    position: ++position,
    payload: e.payload,
    diff: e.diff,
    evidence: evidenceOf(e.payload),
  }));
  await executor.insert(analysisItemsTable).values(rows);
  return rows.length;
}
