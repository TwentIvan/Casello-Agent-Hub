import type { ReactNode } from "react";
import { Link } from "wouter";
import { Check, MessageSquareShare, X } from "lucide-react";
import { Led, type LedState } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ProposalLike, ProposalStatus } from "./adapters";
import { LUCIUS_KIND_LABELS, LuciusPreview } from "./proposal-previews";

// Schede delle conversazioni dei personaggi: `decision` di Alfred (decide una voce della coda), `handoff` (passa la domanda
// all'altro personaggio) e le proposte di Lucius su agenti, skill e modelli di squadra.

const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: "In attesa",
  accepted: "Accettata",
  rejected: "Rifiutata",
  stale: "Superata",
};

const STATUS_LED: Record<ProposalStatus, LedState> = {
  pending: "ask",
  accepted: "ok",
  rejected: "idle",
  stale: "ko",
};

const QUEUE_KIND_LABELS: Record<string, string> = {
  action: "Azione",
  plan: "Piano",
  plan_change: "Modifica del piano",
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface CardProps {
  proposal: ProposalLike;
  /** Oggetto della conversazione (es. id dell'agente), per le anteprime. */
  subjectId: string | null;
  deciding: boolean;
  readOnly: boolean;
  onDecide: (decision: "accept" | "reject") => void;
  /** Scheda `handoff`: accetta (se in attesa) e apre l'altro personaggio con la domanda. */
  onHandoff: () => void;
}

function Shell({ title, status, rationale, children, actions }: {
  title: ReactNode;
  status: ProposalStatus;
  rationale: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card className={cn(status !== "pending" && "opacity-80")}>
      <CardContent className="min-w-0 space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-words text-label">{title}</p>
          <Led state={STATUS_LED[status]} label={STATUS_LABELS[status]} />
        </div>
        {rationale && <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">{rationale}</p>}
        {children}
        {actions && <div className="flex flex-wrap justify-end gap-2 border-t pt-3">{actions}</div>}
      </CardContent>
    </Card>
  );
}

function DiscardButton({ disabled, onClick, label = "Rifiuta" }: { disabled: boolean; onClick: () => void; label?: string }) {
  return (
    <Button variant="outline" size="sm" disabled={disabled} onClick={onClick}>
      <X />
      {label}
    </Button>
  );
}

function DecisionCard({ proposal, deciding, readOnly, onDecide }: CardProps) {
  const p = proposal.payload ?? {};
  const approve = p.decision === "approva";
  const needsUserToken = p.needsUserToken === true;
  const pending = proposal.status === "pending";
  const disabled = deciding || readOnly;
  const meta = [QUEUE_KIND_LABELS[str(p.kind)] ?? str(p.kind), str(p.teamName)].filter(Boolean).join(" · ");

  return (
    <Shell
      title={`Voce #${typeof p.number === "number" ? p.number : "?"} · ${approve ? "da approvare" : "da rifiutare"}`}
      status={proposal.status}
      rationale={proposal.rationale}
      actions={
        pending && (
          <>
            <DiscardButton label="Scarta la scheda" disabled={disabled} onClick={() => onDecide("reject")} />
            {approve && needsUserToken ? (
              <Button asChild size="sm" variant="secondary">
                <Link href="/pending-actions">Apri Da confermare</Link>
              </Button>
            ) : (
              <Button size="sm" disabled={disabled} onClick={() => onDecide("accept")}>
                <Check />
                {approve ? "Approva" : "Rifiuta"}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="min-w-0 space-y-1 rounded-md border p-3">
        {meta && <p className="text-label text-ink-muted">{meta}</p>}
        <p className="whitespace-pre-wrap break-words text-sm">{str(p.summary)}</p>
        {!approve && str(p.note) && (
          <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">Nota: {str(p.note)}</p>
        )}
      </div>
      {pending && approve && needsUserToken && (
        <p className="text-sm text-ink-muted">Questa voce richiede il tuo token per il servizio: approvala dalla pagina Da confermare.</p>
      )}
    </Shell>
  );
}

function HandoffCard({ proposal, deciding, readOnly, onDecide, onHandoff }: CardProps) {
  const p = proposal.payload ?? {};
  const toAlfred = p.to === "alfred";
  const label = toAlfred ? "Chiedo ad Alfred" : "Chiedo a Lucius";
  const open = proposal.status === "pending" || proposal.status === "accepted";

  return (
    <Shell
      title={toAlfred ? "Domanda per Alfred" : "Domanda per Lucius"}
      status={proposal.status}
      rationale={proposal.rationale}
      actions={
        open && (
          <>
            {proposal.status === "pending" && (
              <DiscardButton label="Scarta la scheda" disabled={deciding || readOnly} onClick={() => onDecide("reject")} />
            )}
            <Button size="sm" disabled={deciding || (readOnly && proposal.status === "pending")} onClick={onHandoff}>
              <MessageSquareShare />
              {label}
            </Button>
          </>
        )
      }
    >
      <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3 text-sm">{str(p.question)}</blockquote>
    </Shell>
  );
}

function LuciusCard({ proposal, subjectId, deciding, readOnly, onDecide }: CardProps) {
  const pending = proposal.status === "pending";
  const disabled = deciding || readOnly;
  return (
    <Shell
      title={LUCIUS_KIND_LABELS[proposal.kind] ?? proposal.kind}
      status={proposal.status}
      rationale={proposal.rationale}
      actions={
        pending && (
          <>
            <DiscardButton disabled={disabled} onClick={() => onDecide("reject")} />
            <Button size="sm" disabled={disabled} onClick={() => onDecide("accept")}>
              <Check />
              Accetta
            </Button>
          </>
        )
      }
    >
      {proposal.payload && <LuciusPreview kind={proposal.kind} payload={proposal.payload} subjectId={subjectId} />}
    </Shell>
  );
}

/** Scheda di una conversazione dei personaggi: nulla cambia finché non si accetta. */
export function CharacterProposalCard(props: CardProps) {
  if (props.proposal.kind === "decision") return <DecisionCard {...props} />;
  if (props.proposal.kind === "handoff") return <HandoffCard {...props} />;
  return <LuciusCard {...props} />;
}
