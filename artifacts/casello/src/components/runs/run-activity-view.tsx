import { useEffect, useState } from "react";
import type { RunActivity } from "@workspace/api-client-react";
import { LedDot } from "@/components/brand/led";
import { runActivityLines } from "@/lib/run-activity";

/** Cosa sta facendo ora la run (modello, tool in esecuzione), con il cronometro che scatta ogni secondo. */
export function RunActivityView({ activity }: { activity: RunActivity | null | undefined }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-w-0 space-y-1 text-body-sm text-ink" aria-live="polite">
      {runActivityLines(activity, nowMs).map((line, i) => (
        <p key={i} className="flex min-w-0 items-start gap-2 break-words">
          <LedDot state="work" className="mt-1.5" />
          <span className="min-w-0 break-words">{line.text}</span>
          {line.elapsed && <span className="shrink-0 font-mono text-ink-muted" aria-hidden="true">· {line.elapsed}</span>}
        </p>
      ))}
    </div>
  );
}
