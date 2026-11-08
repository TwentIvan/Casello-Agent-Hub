import type { PendingActionRow, PendingActionStepRow } from "@workspace/db";
import { stepRefs } from "./proposal";

// Vista pubblica di una proposta multipla per la coda: titolo, motivo e passi con argomenti oscurati e riferimenti.

export interface QueuedProposalStepView {
  key: string;
  position: number;
  toolName: string | null;
  summary: string;
  argsPublic: unknown;
  refs: { param: string; step: string; field: string[] }[];
  status: PendingActionStepRow["status"];
  result: string | null;
  errorMessage: string | null;
}
export interface QueuedProposalView {
  title: string;
  reason: string | null;
  steps: QueuedProposalStepView[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toProposalView(
  action: PendingActionRow,
  steps: PendingActionStepRow[],
  toolNames: Map<number, string>,
): QueuedProposalView | null {
  if (action.kind !== "proposal") return null;
  const pub = isObject(action.argsPublic) ? action.argsPublic : {};
  const publicSteps = Array.isArray(pub.steps) ? pub.steps.filter(isObject) : [];
  const argsByKey = new Map<string, unknown>(publicSteps.map((s) => [String(s.key), s.args]));
  return {
    title: typeof pub.title === "string" ? pub.title : action.summary,
    reason: typeof pub.reason === "string" ? pub.reason : null,
    steps: steps.map((s) => {
      const argsPublic = argsByKey.get(s.key) ?? {};
      const refs = stepRefs(argsPublic);
      return {
        key: s.key,
        position: s.position,
        toolName: toolNames.get(s.toolId) ?? null,
        summary: s.summary,
        argsPublic,
        refs: Array.isArray(refs) ? refs : [],
        status: s.status,
        result: s.result,
        errorMessage: s.errorMessage,
      };
    }),
  };
}
