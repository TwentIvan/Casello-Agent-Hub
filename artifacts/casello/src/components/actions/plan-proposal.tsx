import type { QueuedAction, QueuedActionKind } from "@workspace/api-client-react";

export const ACTION_KIND_LABELS: Record<QueuedActionKind, string> = {
  action: "Azione",
  plan: "Piano",
  plan_change: "Modifica del piano",
  proposal: "Proposta",
};

export function isPlanItem(action: Pick<QueuedAction, "kind">): boolean {
  return action.kind === "plan" || action.kind === "plan_change";
}

interface ProposalTask {
  id: string;
  title: string;
  roleKey: string;
}

/** Contenuto di una voce `plan`/`plan_change` (args = { planVersion, objective, constraints, tasks, changes? }). */
function readProposal(args: unknown) {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const tasks = Array.isArray(a.tasks)
    ? a.tasks.filter(
        (t): t is ProposalTask =>
          !!t && typeof t === "object" && typeof (t as ProposalTask).id === "string" && typeof (t as ProposalTask).title === "string",
      )
    : [];
  return {
    planVersion: typeof a.planVersion === "number" ? a.planVersion : null,
    objective: typeof a.objective === "string" ? a.objective : "",
    constraints: strings(a.constraints),
    tasks,
    changes: typeof a.changes === "string" ? a.changes : null,
  };
}

/**
 * Dettaglio di un piano (o di una modifica del piano) proposto dal capo: al posto degli argomenti di uno strumento.
 * `roleName` traduce la chiave del ruolo nel nome, quando la squadra è nota.
 */
export function PlanProposalDetail({ args, roleName }: { args: unknown; roleName?: (key: string) => string }) {
  const p = readProposal(args);
  return (
    <div className="space-y-3 text-sm">
      {p.planVersion !== null && <p className="text-xs text-muted-foreground">Versione {p.planVersion} del piano</p>}
      {p.changes && (
        <div>
          <div className="text-xs text-muted-foreground">Modifiche rispetto al piano approvato</div>
          <p className="break-words">{p.changes}</p>
        </div>
      )}
      {p.objective && (
        <div>
          <div className="text-xs text-muted-foreground">Obiettivo</div>
          <p className="whitespace-pre-wrap break-words">{p.objective}</p>
        </div>
      )}
      {p.constraints.length > 0 && (
        <div>
          <div className="text-xs text-muted-foreground">Vincoli</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {p.constraints.map((c, i) => (
              <li key={i} className="break-words">
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="text-xs text-muted-foreground">Compiti ({p.tasks.length})</div>
        {p.tasks.length === 0 ? (
          <p className="text-muted-foreground">Nessun compito.</p>
        ) : (
          <ol className="space-y-0.5">
            {p.tasks.map((t) => (
              <li key={t.id} className="flex min-w-0 flex-wrap gap-x-2">
                <span className="font-mono text-xs leading-5 text-muted-foreground">{t.id}</span>
                <span className="min-w-0 break-words">{t.title}</span>
                <span className="text-muted-foreground">· {roleName ? roleName(t.roleKey) : t.roleKey}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
