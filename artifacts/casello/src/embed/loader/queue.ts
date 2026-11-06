// Coda dei messaggi verso l'iframe: prima di «ready» tiene solo l'ultimo per tipo.
// Gli ultimi «theme» e «context» si ricordano e si rimandano a ogni nuovo iframe.
import type { ToFrame } from "../protocol";

const ORDER: ToFrame["type"][] = ["theme", "context", "open"];

export function createOutbox(post: (m: ToFrame) => void) {
  let isReady = false;
  const pending = new Map<ToFrame["type"], ToFrame>();
  const last = new Map<ToFrame["type"], ToFrame>();
  return {
    send(m: ToFrame): void {
      if (m.type !== "open") last.set(m.type, m);
      if (isReady) post(m);
      else pending.set(m.type, m);
    },
    ready(): void {
      if (isReady) return;
      isReady = true;
      for (const type of ORDER) {
        const m = pending.get(type) ?? last.get(type);
        if (m) post(m);
      }
      pending.clear();
    },
    /** Torna a «non pronto»: da chiamare quando si ricrea l'iframe. */
    reset(): void {
      isReady = false;
      pending.clear();
    },
  };
}
