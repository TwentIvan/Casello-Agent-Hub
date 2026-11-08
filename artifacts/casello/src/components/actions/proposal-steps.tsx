import type { QueuedProposal, QueuedProposalStep, QueuedProposalStepStatus } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Led, type LedState } from "@/components/brand/led";
import { dependentsOf } from "@/lib/proposal-steps";

const STEP_LED: Record<QueuedProposalStepStatus, { state: LedState; label: string }> = {
  pending: { state: "idle", label: "da eseguire" },
  excluded: { state: "idle", label: "escluso" },
  skipped: { state: "idle", label: "saltato" },
  done: { state: "ok", label: "eseguito" },
  failed: { state: "ko", label: "fallito" },
  not_run: { state: "idle", label: "non eseguito" },
};

const OUTCOME_MAX = 300;

function truncate(text: string): string {
  return text.length > OUTCOME_MAX ? `${text.slice(0, OUTCOME_MAX)}…` : text;
}

/** «id creato al passo p2» (con il campo se diverso da `id`: «slug creato al passo p2»). */
function refLabel(ref: QueuedProposalStep["refs"][number]): string {
  const field = ref.field.join(".");
  return `${ref.param}: ${field === "id" ? "id" : field} creato al passo ${ref.step}`;
}

function StepTitle({ step }: { step: QueuedProposalStep }) {
  return (
    <>
      <span className="break-words text-body-sm">{step.summary}</span>
      <span className="block break-words font-mono text-caption text-ink-muted">{step.toolName ?? "strumento eliminato"}</span>
    </>
  );
}

function StepDetails({ step }: { step: QueuedProposalStep }) {
  return (
    <>
      {step.refs.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {step.refs.map((r, i) => (
            <li key={i} className="break-words font-mono text-caption text-ink-muted">
              {refLabel(r)}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-1">
        <summary className="cursor-pointer text-caption text-ink-muted">Argomenti</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-caption">
          {JSON.stringify(step.argsPublic, null, 2)}
        </pre>
      </details>
    </>
  );
}

/**
 * Passi di una proposta. Con `onToggle` ogni passo ha una casella (spuntato = si esegue, tolta la spunta = escluso; un
 * passo che usa un passo escluso è saltato a catena, disattivato). Senza, mostra lo stato di ogni passo con il LED e
 * l'esito o l'errore.
 */
export function ProposalSteps({
  proposal,
  excluded,
  onToggle,
}: {
  proposal: QueuedProposal;
  excluded?: Set<string>;
  onToggle?: (key: string) => void;
}) {
  const skipped = onToggle ? dependentsOf(proposal.steps, excluded ?? new Set()) : new Set<string>();
  return (
    <ol className="min-w-0 space-y-3">
      {proposal.steps.map((step) => {
        const interactive = onToggle !== undefined;
        const isSkipped = skipped.has(step.key);
        const isExcluded = excluded?.has(step.key) ?? false;
        const led = STEP_LED[step.status];
        const outcome = step.errorMessage ?? step.result;
        const inputId = `proposal-step-${step.key}`;
        return (
          <li key={step.key} className="flex min-w-0 gap-2">
            <span className="w-6 shrink-0 font-mono text-caption leading-5 text-ink-muted">{step.key}</span>
            <div className="min-w-0 flex-1">
              {interactive ? (
                <>
                  <div className="flex min-w-0 items-start gap-2">
                    <Checkbox
                      id={inputId}
                      className="mt-0.5"
                      checked={!isExcluded && !isSkipped}
                      disabled={isSkipped}
                      onCheckedChange={() => onToggle(step.key)}
                    />
                    <label htmlFor={inputId} className="min-w-0 flex-1">
                      <span className="font-mono text-caption text-ink-muted">{step.key} </span>
                      <StepTitle step={step} />
                      {isSkipped && <span className="block text-caption text-ink-muted">salta: usa un passo escluso</span>}
                    </label>
                  </div>
                  <StepDetails step={step} />
                </>
              ) : (
                <>
                  <Led state={led.state} label={led.label} />
                  <StepTitle step={step} />
                  <StepDetails step={step} />
                  {outcome && (
                    <p className={`mt-1 break-words text-caption ${step.errorMessage ? "text-danger" : "text-ink-muted"}`}>
                      {truncate(outcome)}
                    </p>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
