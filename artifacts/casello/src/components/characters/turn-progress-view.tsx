import { useEffect, useState, type ReactNode } from "react";
import type { TurnProgress } from "@workspace/api-client-react";
import { LedDot } from "@/components/brand/led";
import { cn } from "@/lib/utils";
import { progressLines } from "./turn-progress";

/**
 * Passi del turno in corso; il cronometro scatta ogni secondo solo finché il componente è montato. `action` (il pulsante
 * «Ferma») sta accanto ai passi.
 */
export function TurnProgressView({ progress, name, action }: { progress: TurnProgress | null; name: string; action?: ReactNode }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const { lines, elapsed } = progressLines(progress, name, nowMs);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1 text-body-sm text-ink-muted" aria-live="polite">
        {lines.map((l, i) => (
          <p key={i} className={cn("flex items-start gap-2 break-words", l.state === "work" && "text-ink")}>
            {l.state === "work" ? <LedDot state="work" className="mt-1.5" /> : <span className="w-2 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 break-words">{l.text}</span>
            {l.state === "work" && i === lines.length - 1 && elapsed && <span className="shrink-0 font-mono" aria-hidden="true">· {elapsed}</span>}
          </p>
        ))}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
