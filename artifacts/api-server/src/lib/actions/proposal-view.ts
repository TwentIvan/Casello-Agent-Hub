import type { PendingActionRow, PendingActionStepRow } from "@workspace/db";
import { stepRefs, type StepRef } from "./proposal";

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

function isStepRef(v: unknown): v is StepRef {
  return (
    isObject(v) &&
    typeof v.param === "string" &&
    typeof v.step === "string" &&
    Array.isArray(v.field) &&
    v.field.every((f) => typeof f === "string")
  );
}

/**
 * Riferimenti di un passo degli argomenti pubblici: quelli salvati alla proposta (calcolati sugli argomenti veri,
 * anche dentro i parametri `x-sensitive`), altrimenti, per le voci più vecchie, ricalcolati dagli argomenti pubblici.
 */
export function publicStepRefs(step: Record<string, unknown> | undefined): StepRef[] {
  if (step && Array.isArray(step.refs) && step.refs.every(isStepRef)) {
    return step.refs.map((r) => ({ param: r.param, step: r.step, field: [...r.field] }));
  }
  const refs = stepRefs(step?.args ?? {});
  return Array.isArray(refs) ? refs : [];
}

/** Passi degli argomenti pubblici di una proposta, per chiave. */
export function publicStepsByKey(argsPublic: unknown): Map<string, Record<string, unknown>> {
  const pub = isObject(argsPublic) ? argsPublic : {};
  const steps = Array.isArray(pub.steps) ? pub.steps.filter(isObject) : [];
  return new Map(steps.map((s) => [String(s.key), s]));
}

export function toProposalView(
  action: PendingActionRow,
  steps: PendingActionStepRow[],
  toolNames: Map<number, string>,
): QueuedProposalView | null {
  if (action.kind !== "proposal") return null;
  const pub = isObject(action.argsPublic) ? action.argsPublic : {};
  const byKey = publicStepsByKey(action.argsPublic);
  return {
    title: typeof pub.title === "string" ? pub.title : action.summary,
    reason: typeof pub.reason === "string" ? pub.reason : null,
    steps: steps.map((s) => {
      const pubStep = byKey.get(s.key);
      const argsPublic = pubStep?.args ?? {};
      return {
        key: s.key,
        position: s.position,
        toolName: toolNames.get(s.toolId) ?? null,
        summary: s.summary,
        argsPublic,
        refs: publicStepRefs(pubStep),
        status: s.status,
        result: s.result,
        errorMessage: s.errorMessage,
      };
    }),
  };
}
