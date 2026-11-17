import type { CharacterInstructionProposal } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

/** LED, etichetta e possibilità di decidere di una scheda di istruzioni personali. */
export function instructionCardState(p: Pick<CharacterInstructionProposal, "status">): {
  led: LedState;
  label: string;
  canDecide: boolean;
} {
  switch (p.status) {
    case "pending":
      return { led: "ask", label: "Da decidere", canDecide: true };
    case "accepted":
      return { led: "ok", label: "Accettata", canDecide: false };
    case "rejected":
      return { led: "idle", label: "Rifiutata", canDecide: false };
    case "stale":
      return { led: "idle", label: "Superata: chiedi una proposta aggiornata", canDecide: false };
  }
}

/** Schede legate a un messaggio noto; le altre (senza messaggio o di un messaggio non più presente) vanno in fondo. */
export function proposalsByMessage(
  list: CharacterInstructionProposal[],
  messageIds: number[],
): { byMessage: Map<number, CharacterInstructionProposal[]>; trailing: CharacterInstructionProposal[] } {
  const known = new Set(messageIds);
  const byMessage = new Map<number, CharacterInstructionProposal[]>();
  const trailing: CharacterInstructionProposal[] = [];
  for (const p of list) {
    if (p.messageId !== null && known.has(p.messageId)) {
      const group = byMessage.get(p.messageId) ?? [];
      group.push(p);
      byMessage.set(p.messageId, group);
    } else trailing.push(p);
  }
  return { byMessage, trailing };
}
