import { useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  type AnalysisItem,
  type PlanProposal,
  getGetAppPlanQueryKey,
  useDecidePlanProposal,
} from "@workspace/api-client-react";
import { CHAPTER_LABELS, prettyJson } from "@/components/analysis/payload";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

// Le chiavi del dettaglio di una conversazione sono /api/plan-conversations/:id.
const isConversationQuery = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && head.startsWith("/api/plan-conversations");
};

const KIND_LABELS: Record<PlanProposal["kind"], string> = {
  add: "Nuova voce",
  update: "Modifica",
  discard: "Scarta",
};

const STATUS_LABELS: Record<PlanProposal["status"], string> = {
  pending: "In attesa",
  accepted: "Accettata",
  rejected: "Rifiutata",
  stale: "Superata",
};

const STATUS_STYLES: Record<PlanProposal["status"], string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  accepted: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground",
  stale: "bg-muted text-muted-foreground",
};

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed whitespace-pre">
        {prettyJson(value)}
      </pre>
    </div>
  );
}

interface ProposalCardProps {
  proposal: PlanProposal;
  /** Voce attuale del piano a cui la proposta si riferisce (update e discard), se ancora presente. */
  currentItem?: AnalysisItem;
  appId: number;
}

/** Una proposta del bot: si accetta o si rifiuta; nulla cambia nel piano finché non si accetta. */
export function ProposalCard({ proposal, currentItem, appId }: ProposalCardProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);

  const decide = useDecidePlanProposal({
    mutation: {
      onSuccess: (_result, { data }) => {
        toast({ title: data.action === "accept" ? "Proposta accettata" : "Proposta rifiutata", description: proposal.title });
        void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) });
        void queryClient.invalidateQueries({ predicate: isConversationQuery });
      },
      onError: (error) => {
        // 409: già decisa o voce cambiata nel frattempo; la conversazione si rilegge per mostrare lo stato vero
        toast({ variant: "destructive", title: "Operazione non riuscita", description: apiErrorMessage(error) });
        void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) });
        void queryClient.invalidateQueries({ predicate: isConversationQuery });
      },
    },
  });

  const pending = proposal.status === "pending";
  const hasPayload = proposal.payload !== null;
  const showCurrent = proposal.kind === "update" && currentItem !== undefined;

  return (
    <Card className={cn(!pending && "opacity-80")}>
      <CardContent className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{KIND_LABELS[proposal.kind]}</Badge>
          <Badge variant="outline">{CHAPTER_LABELS[proposal.chapter]}</Badge>
          <Badge variant="outline" className={cn("border-transparent", STATUS_STYLES[proposal.status])}>
            {STATUS_LABELS[proposal.status]}
          </Badge>
        </div>
        <p className="text-sm font-medium break-words">{proposal.title}</p>
        {proposal.rationale && <p className="text-sm whitespace-pre-wrap text-muted-foreground">{proposal.rationale}</p>}

        {hasPayload && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {expanded ? "Nascondi il contenuto" : "Mostra il contenuto"}
            </button>
            {expanded && (
              <div className={cn("grid gap-2", showCurrent && "md:grid-cols-2")}>
                {showCurrent && <Json label="Attuale" value={currentItem.payload} />}
                <Json label={showCurrent ? "Proposto" : "Contenuto"} value={proposal.payload} />
              </div>
            )}
          </div>
        )}

        {pending && (
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: proposal.id, data: { action: "reject" } })}
            >
              <X />
              Scarta
            </Button>
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: proposal.id, data: { action: "accept" } })}>
              <Check />
              Accetta
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
