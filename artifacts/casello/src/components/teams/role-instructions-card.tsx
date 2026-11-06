import { useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import type { TeamChatProposal } from "@workspace/api-client-react";
import { Led, type LedState } from "@/components/brand/led";
import { Markdown } from "@/components/plan/markdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<TeamChatProposal["status"], string> = {
  pending: "In attesa",
  accepted: "Accettata",
  rejected: "Rifiutata",
  stale: "Superata",
};

const STATUS_LED: Record<TeamChatProposal["status"], LedState> = {
  pending: "ask",
  accepted: "ok",
  rejected: "idle",
  stale: "ko",
};

/** Testo proposto: `text` per l'identità, `markdown` per le istruzioni. */
export function proposalText(proposal: TeamChatProposal): string {
  const payload = proposal.payload;
  if (!payload) return "";
  const value = proposal.kind === "role_identity" ? payload.text : payload.markdown;
  return typeof value === "string" ? value : "";
}

interface RoleInstructionsCardProps {
  proposal: TeamChatProposal;
  /** Nome del ruolo, se la squadra lo conosce ancora (altrimenti si mostra la chiave). */
  roleName?: string;
  deciding?: boolean;
  onDecide: (action: "accept" | "reject") => void;
}

/** Proposta di Lucius su identità o istruzioni di un ruolo: nulla cambia finché non si accetta. */
export function RoleInstructionsCard({ proposal, roleName, deciding = false, onDecide }: RoleInstructionsCardProps) {
  const [compare, setCompare] = useState(false);
  const pending = proposal.status === "pending";
  const label = proposal.kind === "role_identity" ? "Identità di" : "Istruzioni di";
  const proposed = proposalText(proposal);

  return (
    <Card className={cn(!pending && "opacity-80")}>
      <CardContent className="min-w-0 space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-words text-label">
            {label} {roleName ?? proposal.roleKey}
          </p>
          <Led state={STATUS_LED[proposal.status]} label={STATUS_LABELS[proposal.status]} />
        </div>
        {proposal.rationale && <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">{proposal.rationale}</p>}

        <div className="max-h-96 min-w-0 overflow-y-auto rounded-md border p-3">
          {proposed ? <Markdown>{proposed}</Markdown> : <p className="text-sm text-muted-foreground">Nessun testo.</p>}
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setCompare((v) => !v)}
            aria-expanded={compare}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {compare ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Confronta con l'attuale
          </button>
          {compare && (
            <div className="grid gap-2 md:grid-cols-2">
              <Text label="Attuale" value={proposal.currentValue} />
              <Text label="Proposto" value={proposed} />
            </div>
          )}
        </div>

        {pending && (
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" size="sm" disabled={deciding} onClick={() => onDecide("reject")}>
              <X />
              Rifiuta
            </Button>
            <Button size="sm" disabled={deciding} onClick={() => onDecide("accept")}>
              <Check />
              Accetta
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Text({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs leading-relaxed">
        {value || "(vuoto)"}
      </pre>
    </div>
  );
}
