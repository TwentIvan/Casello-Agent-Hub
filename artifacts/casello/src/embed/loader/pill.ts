// Aspetto del pulsante a pillola della pagina ospite secondo lo stato mandato dall'iframe (funzione pura).
import type { StatusPayload } from "../protocol";

export type PillView = { label: string; count: number | null; led: "work" | "ask" | null };

/** Stato iniziale, prima di qualunque messaggio dell'iframe (e senza collegamento). */
export const IDLE_STATUS: StatusPayload = { pending: 0, bugs: 0, working: false, unread: false, actions: 0 };

/**
 * Etichetta «Botcave» o «Botcave · N azioni» (stretto: nessuna, resta il segno), contatore voci da confermare più
 * segnalazioni (null se zero), LED `work` se un bot sta rispondendo, altrimenti `ask` se c'è una risposta non vista.
 */
export function pillView(s: StatusPayload, narrow: boolean): PillView {
  const label = narrow ? "" : s.actions > 0 ? `Botcave · ${s.actions === 1 ? "1 azione" : `${s.actions} azioni`}` : "Botcave";
  const total = s.pending + s.bugs;
  return { label, count: total > 0 ? total : null, led: s.working ? "work" : s.unread ? "ask" : null };
}
