import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

/*
 * La volta della caverna: stalattiti in pixel quadrati che pendono dal soffitto, come nella copertina del manuale di
 * marca. Colori solo dai token: roccia in ombra (ardesia) sul buio (notte), un solo pixel ambra (il LED).
 * Disegno deterministico: ogni colonna ha la sua lunghezza, il motivo si ripete in larghezza.
 */

// Lunghezza (in pixel) di ogni colonna di stalattiti, letta da sinistra; il motivo si ripete.
const STALACTITES = [3, 1, 4, 2, 4, 1, 3, 2, 5, 2, 4, 1, 3, 1, 4, 2];
// La colonna che termina con il LED ambra (indice nel motivo) e la sua lunghezza.
const LED_COLUMN = 4;

const PIXEL = 12;
const GAP = 6;
const STEP = PIXEL + GAP;

interface VaultProps {
  /** Numero di colonne disegnate (la larghezza la decide il contenitore: l'SVG taglia a destra). */
  columns?: number;
  /** Righe visibili: le stalattiti più lunghe vengono tagliate in basso. */
  rows?: number;
  /** Mostra il pixel ambra in fondo alla stalattite più lunga. */
  led?: boolean;
  /** Colore della roccia: ardesia sul buio (volta) oppure roccia in luce sullo sfondo della pagina (separatore). */
  tone?: "vault" | "page";
  /** Dimensione fissa (fattore sui pixel del disegno) invece di riempire il contenitore. */
  scale?: number;
  className?: string;
}

/** Stalattiti in pixel. Decorative: nascoste ai lettori di schermo. */
export function CaveStalactites({ columns = 32, rows = 6, led = true, tone = "vault", scale, className }: VaultProps) {
  const rock = tone === "vault" ? "var(--ardesia)" : "var(--mark-rock)";
  const width = columns * STEP - GAP + GAP * 2;
  const height = rows * STEP;
  const rects: ReactElement[] = [];
  for (let c = 0; c < columns; c++) {
    const length = Math.min(STALACTITES[c % STALACTITES.length], rows);
    const isLed = led && c === LED_COLUMN;
    for (let r = 0; r < length; r++) {
      const last = r === length - 1;
      rects.push(
        <rect
          key={`${c}-${r}`}
          x={GAP + c * STEP}
          y={r * STEP}
          width={PIXEL}
          height={PIXEL}
          fill={isLed && last ? "var(--ambra)" : rock}
        />,
      );
    }
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={scale === undefined ? "xMinYMin slice" : "xMinYMin meet"}
      width={scale === undefined ? undefined : width * scale}
      height={scale === undefined ? undefined : height * scale}
      className={cn("block", className)}
    >
      {rects}
    </svg>
  );
}

/**
 * Copertina della dashboard: a sinistra la scritta «bot·cave» con il motto, a destra la volta buia con le stalattiti
 * e la fascia di roccia. Sotto i 768 px la volta diventa una striscia sopra la scritta.
 */
export function CaveCover({ className }: { className?: string }) {
  return (
    <section
      aria-label="Botcave"
      className={cn("overflow-hidden rounded-lg border bg-surface-1 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,40%)]", className)}
    >
      <div className="order-2 flex flex-col justify-end gap-3 p-6 md:order-1 md:min-h-56 md:p-8">
        <div className="flex items-end gap-6">
          <p className="font-mono text-5xl font-medium leading-none tracking-tight text-ink md:text-6xl" aria-label="Botcave">
            bot
            <span
              aria-hidden="true"
              className="mx-[0.06em] inline-block size-[0.2em] bg-brand align-baseline"
            />
            cave
          </p>
          <span aria-hidden="true" className="mb-1 hidden size-9 shrink-0 bg-brand lg:block" />
        </div>
        <p className="text-body-sm text-ink-muted">Squadre di agenti al lavoro. Tu dirigi, Alfred ti tiene aggiornato.</p>
      </div>
      <div className="order-1 flex flex-col md:order-2" style={{ background: "var(--notte)" }}>
        <CaveStalactites className="h-24 w-full flex-1 md:h-auto md:min-h-44" rows={8} columns={40} />
        <div className="h-3 md:h-9" style={{ background: "var(--mark-rock)" }} />
      </div>
    </section>
  );
}

/** Volta stretta per la barra in alto di ogni pagina: tre righe di stalattiti sul buio. */
export function CaveHeaderVault({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("h-full overflow-hidden", className)} style={{ background: "var(--notte)" }}>
      <CaveStalactites className="h-full w-full" rows={3} columns={20} />
    </div>
  );
}

/** Separatore tra le due aree del menu: una fila corta di stalattiti, senza LED. */
export function CaveDivider({ className }: { className?: string }) {
  return (
    <div role="separator" className={cn("px-3 py-2 group-data-[collapsible=icon]:px-2", className)}>
      <CaveStalactites tone="page" led={false} rows={3} columns={9} scale={0.5} className="group-data-[collapsible=icon]:hidden" />
      <CaveStalactites tone="page" led={false} rows={3} columns={2} scale={0.5} className="hidden group-data-[collapsible=icon]:block" />
    </div>
  );
}
