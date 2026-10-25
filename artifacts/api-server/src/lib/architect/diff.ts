import type { Agent, AgentSkill, AnalysisItem, AppTool } from "@workspace/db";
import { skillKey, type AnalysisChapter } from "./schemas";
import type {
  AgentProposal,
  CompletionItem,
  EndpointProposal,
  EvolutionItem,
  SkillProposal,
  ToolProposal,
} from "./schemas";

// Differenze tra le proposte dell'architetto e ciò che esiste già nell'app. Modulo puro:
// niente DB né rete, i dati esistenti arrivano dal chiamante.

export type ItemDiff = AnalysisItem["diff"];

export interface DiffEntry<T> {
  ref: string;
  diff: ItemDiff;
  payload: T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Uguaglianza profonda indipendente dall'ordine delle chiavi (jsonb non lo conserva). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return Object.is(a, b);
}

const sorted = (names: string[]) => [...new Set(names)].sort();
const trimmed = (area: string | null) => (area ?? "").trim();

// --- Tool ---

export const toolRef = (name: string) => `tool:${name}`;

/**
 * Confronta i tool proposti con quelli esistenti, per `name`. I tool esistenti non riproposti
 * (e non già disattivati) diventano `removed`, con il tool esistente come payload.
 */
export function diffTools(proposed: ToolProposal[], existing: AppTool[]): DiffEntry<ToolProposal | AppTool>[] {
  const byName = new Map(existing.map((t) => [t.name, t]));
  const result: DiffEntry<ToolProposal | AppTool>[] = proposed.map((tool) => {
    const current = byName.get(tool.name);
    let diff: ItemDiff = "new";
    if (current) {
      const same =
        (current.description ?? "") === tool.description &&
        current.identity === tool.identity &&
        current.requiresConfirmation === tool.requiresConfirmation &&
        current.readOnly === tool.readOnly &&
        jsonEqual(current.definition, tool.definition) &&
        jsonEqual(current.paramsSchema, tool.paramsSchema);
      diff = same ? "unchanged" : "changed";
    }
    return { ref: toolRef(tool.name), diff, payload: tool };
  });
  const proposedNames = new Set(proposed.map((t) => t.name));
  for (const tool of existing) {
    if (!proposedNames.has(tool.name) && tool.status !== "disabled") {
      result.push({ ref: toolRef(tool.name), diff: "removed", payload: tool });
    }
  }
  return result;
}

// --- Agenti e skill ---

export const agentRef = (role: string, area: string | null) => (role === "general" ? "agent:general" : `agent:area:${trimmed(area)}`);
/** Stessa chiave del controllo dei duplicati dello schema (`skillKey`): non possono divergere. */
export const skillRef = (role: string, area: string | null, name: string) => `skill:${skillKey(role, area, name)}`;

/** Confronto per (`role`, `area`). Dell'agente generale non si confrontano nome e tool (usa tutti i tool attivi). */
export function diffAgents(
  proposed: AgentProposal[],
  existing: (Agent & { toolNames: string[] })[],
): DiffEntry<AgentProposal>[] {
  return proposed.map((agent) => {
    const current = existing.find(
      (a) => a.role === agent.role && (agent.role === "general" || trimmed(a.area) === trimmed(agent.area)),
    );
    let diff: ItemDiff = "new";
    if (current) {
      const same =
        (current.systemPrompt ?? "") === agent.systemPrompt &&
        current.defaultIdentity === agent.defaultIdentity &&
        (agent.role === "general" ||
          (current.name === agent.name && jsonEqual(sorted(current.toolNames), sorted(agent.toolNames))));
      diff = same ? "unchanged" : "changed";
    }
    return { ref: agentRef(agent.role, agent.area), diff, payload: agent };
  });
}

/** Confronto per (agente, `name`). */
export function diffSkills(
  proposed: SkillProposal[],
  existing: (AgentSkill & { agentRole: string; agentArea: string | null })[],
): DiffEntry<SkillProposal>[] {
  return proposed.map((skill) => {
    const current = existing.find(
      (s) =>
        s.name === skill.name &&
        s.agentRole === skill.agentRole &&
        (skill.agentRole === "general" || trimmed(s.agentArea) === trimmed(skill.agentArea)),
    );
    let diff: ItemDiff = "new";
    if (current) {
      const same =
        (current.description ?? "") === skill.description &&
        current.instructions === skill.instructions &&
        jsonEqual(sorted(current.toolNames), sorted(skill.toolNames)) &&
        jsonEqual(current.paramsSchema ?? null, skill.paramsSchema ?? null);
      diff = same ? "unchanged" : "changed";
    }
    return { ref: skillRef(skill.agentRole, skill.agentArea, skill.name), diff, payload: skill };
  });
}

// --- Capitoli senza controparte esistente: sempre `new` ---

type NewOnly = { chapter: "endpoint"; items: EndpointProposal[] } | { chapter: "completion"; items: CompletionItem[] } | { chapter: "evolution"; items: EvolutionItem[] };

export function diffAlwaysNew(input: NewOnly): DiffEntry<EndpointProposal | CompletionItem | EvolutionItem>[] {
  const refOf = (item: EndpointProposal | CompletionItem | EvolutionItem, index: number): string => {
    switch (input.chapter) {
      case "endpoint":
        return `endpoint:${(item as EndpointProposal).method.toUpperCase()} ${(item as EndpointProposal).path}`;
      case "completion":
        return `completion:${(item as CompletionItem).key}`;
      case "evolution":
        return `evolution:${index + 1}`;
    }
  };
  return (input.items as (EndpointProposal | CompletionItem | EvolutionItem)[]).map((item, index) => ({
    ref: refOf(item, index),
    diff: "new" as const,
    payload: item,
  }));
}

export type { AnalysisChapter };
