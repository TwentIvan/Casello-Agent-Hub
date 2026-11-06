import { useMemo } from "react";
import { cn } from "@/lib/utils";

type Row = { left: string | null; right: string | null; same: boolean };

// Oltre questa dimensione (righe A × righe B) si confronta riga per riga nella stessa posizione.
const MAX_LCS_CELLS = 4_000_000;

/** Allinea due testi per righe: le righe in comune restano affiancate, le altre sono evidenziate. */
export function diffLines(a: string, b: string): Row[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > MAX_LCS_CELLS) {
    return Array.from({ length: Math.max(x.length, y.length) }, (_, i) => ({
      left: x[i] ?? null,
      right: y[i] ?? null,
      same: x[i] === y[i],
    }));
  }
  // lcs[i][j] = lunghezza della sottosequenza comune di x[i..] e y[j..]
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      rows.push({ left: x[i], right: y[j], same: true });
      i++;
      j++;
    } else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      rows.push({ left: x[i], right: null, same: false });
      i++;
    } else {
      rows.push({ left: null, right: y[j], same: false });
      j++;
    }
  }
  return rows;
}

function Cell({ text, changed, tone }: { text: string | null; changed: boolean; tone: string }) {
  return (
    <div
      className={cn(
        "min-h-6 whitespace-pre-wrap break-words px-2 py-0.5 font-mono text-xs",
        changed && text !== null && tone,
        text === null && "bg-muted/40",
      )}
    >
      {text}
    </div>
  );
}

interface SkillDiffProps {
  labelA: string;
  labelB: string;
  contentA: string;
  contentB: string;
}

/** Due versioni affiancate; le righe diverse hanno il fondo danger a sinistra e success a destra. */
export function SkillDiff({ labelA, labelB, contentA, contentB }: SkillDiffProps) {
  const rows = useMemo(() => diffLines(contentA, contentB), [contentA, contentB]);
  const identical = rows.every((r) => r.same);
  return (
    <div className="space-y-2">
      {identical && <p className="text-sm text-muted-foreground">I due testi sono identici.</p>}
      <div className="grid grid-cols-2 overflow-hidden rounded-md border text-sm">
        <div className="border-b bg-muted px-2 py-1 text-xs font-medium">{labelA}</div>
        <div className="border-b border-l bg-muted px-2 py-1 text-xs font-medium">{labelB}</div>
        {rows.map((r, i) => (
          <div key={i} className="contents">
            <Cell text={r.left} changed={!r.same} tone="bg-danger/12" />
            <div className="border-l">
              <Cell text={r.right} changed={!r.same} tone="bg-success/12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
