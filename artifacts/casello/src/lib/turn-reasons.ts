import type { TeamTurnReason } from "@workspace/api-client-react";

/**
 * Testo di un motivo di turno del capo nell'attività della squadra. Un motivo che la console non conosce (`unknown` dal
 * server o un tipo arrivato da una versione più nuova dell'API) ha una riga generica invece di una riga vuota.
 */
export function reasonText(r: TeamTurnReason): string {
  switch (r.type) {
    case "request":
      return r.text ? `Richiesta: ${r.text}` : "Richiesta";
    case "task_finished":
      return r.taskId != null ? `Compito finito (esecuzione #${r.taskId})` : "Compito finito";
    case "decision": {
      const outcome = r.outcome === "approved" ? "approvata" : r.outcome === "rejected" ? "rifiutata" : "decisa";
      return `Voce n. ${r.number ?? "?"} ${outcome}${r.note ? `: ${r.note}` : ""}`;
    }
    case "activation":
      return "Attivazione della squadra";
    case "restart":
      return "Ripresa dopo un riavvio";
    case "ci_finished":
      return r.outcome === "success" ? "CI verde" : r.outcome === "failure" ? "CI non superata" : "Nessuna CI sul branch";
    case "pr_closed":
      return r.merged ? "PR unita" : "PR chiusa senza merge";
    case "merge_failed":
      return r.message ? `Merge non riuscito: ${r.message}` : "Merge non riuscito";
    case "release_failed":
      return r.message ? `Porta in produzione non riuscita: ${r.message}` : "Porta in produzione non riuscita";
    case "unknown":
      return unknownReason(r.originalType);
    default:
      return unknownReason((r as { type?: unknown }).type);
  }
}

function unknownReason(type: unknown): string {
  return typeof type === "string" && type !== "" && type !== "?" ? `Motivo non riconosciuto (${type})` : "Motivo non riconosciuto";
}
