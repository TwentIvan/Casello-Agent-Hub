import type { LeadConversationDetail, LeadQueueItem } from "@workspace/api-client-react";
import type { ConvDetail, ProposalLike } from "./adapters";

// Dalla conversazione con il Responsabile (messaggi dell'utente con le loro run) alla forma comune di `CharacterChat`:
// funzione pura, provata con Vitest. Ogni messaggio dell'utente ha id 2·id; la risposta, se la run è conclusa, 2·id+1.

export const LEAD_RUN_KIND = "lead_run";
export const LEAD_GONE = "risposta non più disponibile";

export type LeadRunPayload = { runId: number; items: LeadQueueItem[] };

const OPEN = new Set(["pending", "running"]);

export function mapLeadDetail(d: LeadConversationDetail): ConvDetail {
  const messages: ConvDetail["messages"] = [];
  const proposals: ProposalLike[] = [];
  for (const m of d.messages) {
    messages.push({ id: 2 * m.id, role: "user", content: m.content, error: false });
    const run = m.run;
    const replyId = 2 * m.id + 1;
    if (!run) {
      messages.push({ id: replyId, role: "assistant", content: LEAD_GONE, error: true });
      continue;
    }
    if (OPEN.has(run.status)) continue;
    if (run.status === "succeeded") {
      messages.push({ id: replyId, role: "assistant", content: run.output?.trim() ? run.output : "(nessuna risposta)", error: false });
    } else {
      messages.push({ id: replyId, role: "assistant", content: run.error ?? "run non riuscita", error: true });
    }
    const payload: LeadRunPayload = { runId: run.id, items: run.items };
    proposals.push({
      id: run.id,
      messageId: replyId,
      kind: LEAD_RUN_KIND,
      status: "accepted",
      payload,
      rationale: "",
      raw: run,
    });
  }
  return {
    id: d.id,
    title: d.title,
    aiModelId: d.aiModelId,
    tokensUsed: d.tokensUsed,
    costUsd: d.costUsd,
    turnStatus: d.turnStatus,
    readOnlyReason: null,
    subjectId: null,
    progress: d.progress ?? null,
    // Il Responsabile non ha la coda dei messaggi
    queuedMessage: null,
    messages,
    proposals,
  };
}
