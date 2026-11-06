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
 * La volta della caverna nella barra in alto di ogni pagina: stalattiti sul buio, con il LED ambra. Riempie in larghezza
 * il contenitore (il motivo si ripete e l'SVG taglia a destra); l'altezza la decide il contenitore.
 */
export function CaveVault({ className }: { className?: string }) {
  return <CaveStalactites className={cn("h-full w-full", className)} rows={5} columns={160} />;
}
