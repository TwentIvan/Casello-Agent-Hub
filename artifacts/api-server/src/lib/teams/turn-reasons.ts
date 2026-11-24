import { ListTeamTurnsResponseItem } from "@workspace/api-zod";
import type { TeamTurnReason } from "@workspace/db";
import { logger } from "../logger";

/**
 * Tipi dei motivi di turno che il capo può ricevere. `satisfies` obbliga ad aggiungere qui ogni tipo nuovo di
 * `TeamTurnReason`; il test verifica che ognuno sia anche nel contratto OpenAPI (altrimenti l'attività lo mostrerebbe
 * come motivo non riconosciuto).
 */
export const TURN_REASON_TYPES = {
  request: true,
  task_finished: true,
  decision: true,
  activation: true,
  restart: true,
  ci_finished: true,
  pr_closed: true,
  merge_failed: true,
  release_failed: true,
} as const satisfies Record<TeamTurnReason["type"], true>;

const ReasonSchema = ListTeamTurnsResponseItem.shape.reasons.element;

export type PublicTurnReason = ReturnType<typeof ReasonSchema.parse>;

/** Tipo salvato, ridotto a un'etichetta sicura da mostrare (mai il contenuto del motivo). */
function originalTypeOf(reason: unknown): string {
  const type = reason && typeof reason === "object" ? (reason as { type?: unknown }).type : undefined;
  if (typeof type !== "string") return "?";
  const clean = type.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 60);
  return clean === "" ? "?" : clean;
}

/**
 * Motivi di un turno per la risposta dell'API: un motivo che il contratto non descrive (tipo nuovo, campi non validi,
 * valore non oggetto) diventa `{type: "unknown", originalType}` invece di far fallire tutta l'attività con un 500.
 */
export function publicTurnReasons(turnId: number, reasons: unknown): PublicTurnReason[] {
  if (!Array.isArray(reasons)) {
    logger.warn({ turnId }, "motivi del turno non leggibili");
    return [];
  }
  return reasons.map((reason) => {
    const parsed = ReasonSchema.safeParse(reason);
    if (parsed.success && parsed.data.type !== "unknown") return parsed.data;
    const originalType = originalTypeOf(reason);
    logger.warn({ turnId, originalType }, "motivo del turno non riconosciuto");
    return { type: "unknown" as const, originalType };
  });
}
