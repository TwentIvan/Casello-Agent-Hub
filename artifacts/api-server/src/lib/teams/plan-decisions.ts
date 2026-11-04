import { and, eq } from "drizzle-orm";
import { db, pendingActionsTable, teamInstancesTable, type PendingActionRow } from "@workspace/db";
import type { DecideResult } from "../actions/decide";
import { TEAM_MESSAGES } from "./rules";
import { getPlanForUpdate, setPlanStatus } from "./plan";
import { enqueueTurnReason } from "./turn-queue";

// Decisione sulle voci `plan` e `plan_change` della coda: approvare rende approvata la versione proposta del PLAN,
// rifiutare lo riporta allo stato precedente (nessuna versione nuova). Dopo la decisione il capo riceve un turno
// con il motivo `decision`, accodato a transazione conclusa.

export const PLAN_DECISION_MESSAGES = {
  superseded: "proposta superata da una versione più recente",
  alreadyDecided: "azione già decisa",
  notFound: "azione non trovata",
} as const;

const fail = (status: 404 | 409, message: string): DecideResult => ({ ok: false, status, message });

/** Squadra della voce, letta fuori dalle transazioni di scrittura; `null` se non esiste più. */
async function loadTeamStatus(instanceId: number | null): Promise<"draft" | "active" | "closed" | null> {
  if (instanceId === null) return null;
  const [row] = await db
    .select({ status: teamInstancesTable.status })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.id, instanceId))
    .limit(1);
  return row?.status ?? null;
}

export async function decidePlanItem(row: PendingActionRow, approved: boolean, note: string | null): Promise<DecideResult> {
  if (row.status !== "pending") return fail(409, PLAN_DECISION_MESSAGES.alreadyDecided);
  const instanceId = row.teamInstanceId;
  const teamStatus = await loadTeamStatus(instanceId);
  const closed = instanceId === null || teamStatus === null || teamStatus === "closed";
  if (closed && approved) return fail(409, TEAM_MESSAGES.teamClosed);
  if (closed) {
    // Rifiutare una voce di una squadra chiusa la toglie dalla coda: niente PLAN da aggiornare, niente turno
    const [rejected] = await db
      .update(pendingActionsTable)
      .set({ status: "rejected", decidedBy: row.userId, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(pendingActionsTable.id, row.id), eq(pendingActionsTable.status, "pending")))
      .returning();
    return rejected ? { ok: true, action: rejected } : fail(409, PLAN_DECISION_MESSAGES.alreadyDecided);
  }

  const decidedAt = new Date();
  const outcome = await db.transaction(async (tx) => {
    // Ordine dei lock (come in correctPlan): prima la riga del PLAN, poi le righe di pending_actions.
    // Versione e stato si confrontano e si scrivono senza che il capo possa proporre nel mezzo.
    const plan = await getPlanForUpdate(instanceId, tx);
    // Un solo passaggio da pending: due richieste concorrenti non decidono due volte
    const [claimed] = await tx
      .update(pendingActionsTable)
      .set(
        approved
          ? { status: "done", decidedBy: row.userId, decidedAt, finishedAt: decidedAt }
          : { status: "rejected", decidedBy: row.userId, decidedAt, decisionNote: note },
      )
      .where(and(eq(pendingActionsTable.id, row.id), eq(pendingActionsTable.status, "pending")))
      .returning();
    if (!claimed) return { kind: "already" as const };

    const current = plan.version === row.planVersion && plan.status === "proposed";

    if (approved) {
      if (!current) {
        const [failed] = await tx
          .update(pendingActionsTable)
          .set({ status: "failed", errorMessage: PLAN_DECISION_MESSAGES.superseded })
          .where(eq(pendingActionsTable.id, row.id))
          .returning();
        return { kind: "superseded" as const, row: failed! };
      }
      await setPlanStatus(instanceId, "approved", row.planVersion, tx);
      return { kind: "decided" as const, row: claimed };
    }

    // Rifiuto: solo se il PLAN è ancora quello proposto; stato di prima, senza versione nuova
    if (current) await setPlanStatus(instanceId, plan.approvedVersion !== null ? "approved" : "draft", undefined, tx);
    return { kind: "decided" as const, row: claimed };
  });

  if (outcome.kind === "already") return fail(409, PLAN_DECISION_MESSAGES.alreadyDecided);
  if (outcome.kind === "superseded") return { ok: true, action: outcome.row };

  await enqueueTurnReason(instanceId, {
    type: "decision",
    number: row.number,
    outcome: approved ? "approved" : "rejected",
    note: approved ? null : note,
  });
  return { ok: true, action: outcome.row };
}
