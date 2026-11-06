import { cn } from "@/lib/utils";

/**
 * LED di stato di Botcave (design/components/Led): pixel quadrato da 8 px, senza raggio, sempre con l'etichetta accanto.
 * - idle: in attesa, fisso;
 * - work: al lavoro, pulsa lentamente;
 * - ask: serve una decisione dell'utente, lampeggia;
 * - ok: concluso;
 * - ko: bloccato, fallito o tetto raggiunto.
 * Con la riduzione del movimento attiva i LED restano fissi (index.css).
 */
export type LedState = "idle" | "work" | "ask" | "ok" | "ko";

const DOT: Record<LedState, string> = {
  idle: "bg-led-idle",
  work: "bg-brand led-work",
  ask: "bg-brand led-ask",
  ok: "bg-success",
  ko: "bg-danger",
};

export function LedDot({ state, className }: { state: LedState; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-none", DOT[state], className)} />;
}

export function Led({
  state,
  label,
  className,
  title,
}: {
  state: LedState;
  label: string;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-body-sm text-ink-muted", className)} title={title}>
      <LedDot state={state} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
