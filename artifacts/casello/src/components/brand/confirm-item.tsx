import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LedDot } from "./led";

/**
 * Voce della coda «Da confermare» (design/components/ConfirmItem): numero, titolo, squadra e lavoro, sintesi, costo
 * facoltativo, nota e i due pulsanti «Rifiuta» (secondario) e «Approva» (principale).
 * Il numero è quello assegnato dal server e non cambia finché la voce resta in coda: è quello che Alfred legge a voce
 * («approva la numero due»), quindi non va mai sostituito con la posizione nell'elenco.
 */
export function ConfirmItem({
  number,
  title,
  meta,
  summary,
  cost,
  note,
  onNoteChange,
  onApprove,
  onReject,
  approveLabel = "Approva",
  rejectLabel = "Rifiuta",
  busy = false,
  extraActions,
  approveSlot,
  children,
  className,
}: {
  number: number;
  title: ReactNode;
  /** Squadra, app e lavoro, già uniti con « · » */
  meta?: ReactNode;
  summary?: ReactNode;
  /** Costo già formattato (es. «0,42 €»); omesso se non noto */
  cost?: string | null;
  note: string;
  onNoteChange: (note: string) => void;
  onApprove: () => void;
  onReject: () => void;
  approveLabel?: string;
  rejectLabel?: string;
  busy?: boolean;
  /** Azioni discrete in più (es. «Dettagli»), a sinistra della nota */
  extraActions?: ReactNode;
  /** Al posto del pulsante «Approva» (es. il collegamento alla console del pannello incorporato) */
  approveSlot?: ReactNode;
  /** Contenuto aggiuntivo tra la sintesi e le azioni (es. il piano proposto) */
  children?: ReactNode;
  className?: string;
}) {
  const noteId = useId();
  return (
    <article
      className={cn("min-w-0 rounded-md border border-border bg-surface-1 p-4 text-ink", className)}
      aria-label={`Voce numero ${number} da confermare`}
    >
      <div className="flex items-center gap-2 text-label text-accent-text">
        <LedDot state="ask" />
        <span>#{number} · da confermare</span>
        {cost && <span className="ml-auto font-mono text-caption text-ink-muted">{cost}</span>}
      </div>
      <p className="mt-2 text-body-strong break-words">{title}</p>
      {meta && <p className="mt-0.5 mb-2 text-caption text-ink-muted break-words">{meta}</p>}
      {summary && <div className="mb-4 text-body-sm break-words">{summary}</div>}
      {children && <div className="mb-4 min-w-0">{children}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {extraActions}
        <label htmlFor={noteId} className="sr-only">
          Nota
        </label>
        <Input
          id={noteId}
          className="min-w-40 flex-1"
          placeholder="Nota (facoltativa)"
          maxLength={500}
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          disabled={busy}
        />
        <Button variant="secondary" disabled={busy} onClick={onReject}>
          {rejectLabel}
        </Button>
        {approveSlot ?? (
          <Button disabled={busy} onClick={onApprove}>
            {approveLabel}
          </Button>
        )}
      </div>
    </article>
  );
}
