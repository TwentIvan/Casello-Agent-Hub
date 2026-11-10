import { ExternalLink } from "lucide-react";
import type { TeamCodeTask } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";
import { ciLabel } from "./task-code";

const CI_LED: Record<NonNullable<TeamCodeTask["ciState"]>, LedState> = {
  pending: "work",
  success: "ok",
  failure: "ko",
  none: "idle",
};

/** Con la PR chiusa o unita la CI non è più un dato da guardare: LED fermo. */
function ledOf(code: TeamCodeTask): LedState {
  if (code.prState === "merged" || code.prState === "closed" || code.ciState === null) return "idle";
  return CI_LED[code.ciState];
}

const PR_STATE_LABELS = { open: "aperta", merged: "unita", closed: "chiusa" } as const;

/** Riga del codice di un compito: branch, PR, stato della CI e riepilogo. */
export function TaskCodeLine({ code }: { code: TeamCodeTask }) {
  const label = code.ciSummary ?? ciLabel(code);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <a
        href={`https://github.com/${code.repo}/tree/${encodeURIComponent(code.branch).replace(/%2F/g, "/")}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-w-0 items-center gap-1 break-all font-mono hover:underline"
      >
        {code.branch}
        <ExternalLink className="size-3 shrink-0" />
      </a>
      {code.prNumber !== null && code.prUrl && (
        <a href={code.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
          PR #{code.prNumber}
          {code.prState && <span className="text-ink-muted">({PR_STATE_LABELS[code.prState]})</span>}
        </a>
      )}
      <Led state={ledOf(code)} label={label} className="min-w-0 text-xs" title={label} />
    </div>
  );
}
