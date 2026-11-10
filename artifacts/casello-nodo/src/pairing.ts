import { HttpError, type PairingClient } from "./client";
import type { Dialogs } from "./dialogs";

/** Intervallo tra due interrogazioni dell'esito (spec §3). */
export const PAIRING_POLL_MS = 3_000;
export const PAIRING_FAILED_TEXT = "Collegamento non riuscito o scaduto: riapri Botcave Nodo";

/** Abbinamento rifiutato, scaduto o già consegnato: il dialogo è già stato mostrato. */
export class PairingFailedError extends Error {
  constructor() {
    super(PAIRING_FAILED_TEXT);
    this.name = "PairingFailedError";
  }
}

export interface PairingDeps {
  caselloUrl: string;
  client: PairingClient;
  dialogs: Dialogs;
  /** Apre un indirizzo o un percorso con `open`. */
  openUrl: (target: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  deviceName: string;
  version: string;
}

/**
 * Collega questo Mac (spec §3): chiede un codice, apre la pagina della console che lo conferma, notifica il codice e
 * interroga l'esito ogni 3 s fino alla scadenza. Il codice e il segreto di interrogazione non finiscono mai nei log.
 * Un errore di `start` (rete, Botcave giù) passa a chi chiama.
 */
export async function runPairing(d: PairingDeps): Promise<{ token: string; nodeId: number; nodeName: string }> {
  const now = d.now ?? (() => new Date());
  const started = await d.client.start({ deviceName: d.deviceName, version: d.version });
  await d.openUrl(`${d.caselloUrl}/nodes/pair?code=${encodeURIComponent(started.userCode)}`);
  await d.dialogs
    .notify("Botcave Nodo", `Codice di collegamento ${started.userCode}: conferma nel browser che si è appena aperto.`)
    .catch(() => {});
  const fail = async (): Promise<never> => {
    await d.dialogs.alert(PAIRING_FAILED_TEXT).catch(() => {});
    throw new PairingFailedError();
  };
  for (;;) {
    await d.sleep(PAIRING_POLL_MS);
    if (now().getTime() > started.expiresAt.getTime()) return fail();
    let result;
    try {
      result = await d.client.poll(started.pairingId, started.pollSecret);
    } catch (e) {
      // Rete, 429 e 5xx: si riprova al giro dopo; un altro 4xx è definitivo
      if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429) return fail();
      continue;
    }
    if (result.status === "approved") return { token: result.token, nodeId: result.nodeId, nodeName: result.nodeName };
    if (result.status === "gone") return fail();
  }
}
