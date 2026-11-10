import { HttpError, type PairingClient } from "./client";
import type { Dialogs } from "./dialogs";

/** Intervallo tra due interrogazioni dell'esito (spec §3). */
export const PAIRING_POLL_MS = 3_000;
/** Durata della richiesta se la risposta non porta l'ora del server (il server la tiene 10 minuti). */
export const PAIRING_FALLBACK_TTL_MS = 12 * 60_000;
/** Margine oltre la durata: l'approvazione proroga la richiesta di 2 minuti (`COLLECT_GRACE_MS` del server). */
export const PAIRING_GRACE_MS = 2 * 60_000;
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
 * interroga l'esito ogni 3 s. Si ferma al 410 del server; la scadenza locale è solo una sicurezza e si calcola come durata
 * (scadenza del server meno l'ora del server della risposta, 12 minuti se manca, più 2 minuti), mai confrontando l'ora del Mac
 * con quella del server: un orologio del Mac avanti o indietro non interrompe l'abbinamento. Il codice e il segreto di interrogazione non finiscono mai nei log.
 * Un errore di `start` (rete, Botcave giù) passa a chi chiama.
 */
export async function runPairing(d: PairingDeps): Promise<{ token: string; nodeId: number; nodeName: string }> {
  const now = d.now ?? (() => new Date());
  const started = await d.client.start({ deviceName: d.deviceName, version: d.version });
  const serverTtl = started.serverNow ? started.expiresAt.getTime() - started.serverNow.getTime() : PAIRING_FALLBACK_TTL_MS;
  const ttl = Math.min(Math.max(serverTtl, 0), PAIRING_FALLBACK_TTL_MS);
  const deadline = now().getTime() + ttl + PAIRING_GRACE_MS;
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
    if (now().getTime() > deadline) return fail();
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
