import type { AlfredLine } from "./use-alfred-voice";

/** Trascrizione delle ultime battute della conversazione, le più recenti in alto. */
export function AlfredTranscript({ lines }: { lines: AlfredLine[] }) {
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">La conversazione comparirà qui.</p>;
  }
  return (
    <ul className="space-y-2">
      {[...lines].reverse().map((line) => (
        <li
          key={line.id}
          className={
            line.role === "user"
              ? "break-words rounded-md bg-surface-2 px-3 py-2 text-sm"
              : "break-words rounded-md border px-3 py-2 text-sm"
          }
        >
          <span className="mr-1 text-label">{line.role === "user" ? "Tu:" : "Alfred:"}</span>
          {line.text}
        </li>
      ))}
    </ul>
  );
}
