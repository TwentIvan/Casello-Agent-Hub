// Avviso di un cambio di stato di un lavoro su branch unico (chiusura, voce «Porta in produzione», rilascio, rifiuto): il
// ciclo di evoluzione lo usa per far avanzare il suo giro subito, senza aspettare il controllo periodico. Registro senza
// dipendenze, così `works.ts` e `release.ts` non importano il ciclo (importazioni circolari).

type Listener = (instanceId: number) => void;

let listener: Listener | null = null;

export function setOnWorkChanged(fn: Listener | null): void {
  listener = fn;
}

/** Da chiamare dopo il commit: un errore del destinatario non risale mai al chiamante. */
export function notifyWorkChanged(instanceId: number): void {
  if (!listener) return;
  try {
    listener(instanceId);
  } catch {
    // Il destinatario registra da sé i propri errori
  }
}
