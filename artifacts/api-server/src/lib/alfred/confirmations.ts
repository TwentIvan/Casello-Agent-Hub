import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, alfredConfirmationsTable, alfredSessionsTable, appToolsTable, pendingActionsTable, teamInstancesTable } from "@workspace/db";
import { approvePending, rejectPending } from "../teams/centralino";
import { logger } from "../logger";

// Conferma a doppio passo (spec §4): `prepareDecision` non decide nulla e consegna un codice di 6 cifre valido 60 s,
// `confirmDecision` lo consuma una volta sola e solo allora approva o rifiuta. Del codice si salva solo l'hash SHA-256.

export const CONFIRM_MESSAGES = {
  notPending: "voce non in attesa",
  needsToken: "questa voce va approvata dalla console: serve il token dell'app",
  expired: "conferma scaduta: ripeti la richiesta",
  noteWithApprove: "la nota si può dare solo con il rifiuto",
  noteTooLong: "nota troppo lunga: al massimo 500 caratteri",
} as const;

/** Errore con messaggio fisso da restituire allo strumento. */
export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationError";
  }
}

const CODE_TTL_MS = 60_000;
const MAX_NOTE = 500;
const MAX_RESULT = 500;

const KIND_LABEL: Record<string, string> = { action: "azione", plan: "piano", plan_change: "modifica del piano" };

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

export interface PreparedDecision {
  codice: string;
  numero: number;
  tipo: string;
  squadra: string | null;
  sintesi: string;
  decisione: "approva" | "rifiuta";
}

export async function prepareDecision(
  userId: number,
  sessionId: number,
  input: { numero: number; decisione: "approva" | "rifiuta"; nota?: string | undefined },
): Promise<PreparedDecision> {
  const note = input.nota?.trim() ? input.nota.trim() : null;
  if (note !== null && input.decisione === "approva") throw new ConfirmationError(CONFIRM_MESSAGES.noteWithApprove);
  if (note !== null && note.length > MAX_NOTE) throw new ConfirmationError(CONFIRM_MESSAGES.noteTooLong);

  const [row] = await db
    .select({
      kind: pendingActionsTable.kind,
      status: pendingActionsTable.status,
      summary: pendingActionsTable.summary,
      identity: appToolsTable.identity,
      teamName: teamInstancesTable.name,
    })
    .from(pendingActionsTable)
    .leftJoin(appToolsTable, eq(appToolsTable.id, pendingActionsTable.toolId))
    .leftJoin(teamInstancesTable, eq(teamInstancesTable.id, pendingActionsTable.teamInstanceId))
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, input.numero)))
    .limit(1);
  if (!row) throw new ConfirmationError("azione non trovata");
  if (row.status !== "pending") throw new ConfirmationError(CONFIRM_MESSAGES.notPending);
  if (input.decisione === "approva" && row.kind === "action" && row.identity === "user") {
    throw new ConfirmationError(CONFIRM_MESSAGES.needsToken);
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.transaction(async (tx) => {
    // La riga della sessione serializza due preparazioni concorrenti: resta aperta una sola conferma
    await tx.select({ id: alfredSessionsTable.id }).from(alfredSessionsTable).where(eq(alfredSessionsTable.id, sessionId)).for("update");
    const now = new Date();
    await tx
      .update(alfredConfirmationsTable)
      .set({ usedAt: now })
      .where(and(eq(alfredConfirmationsTable.sessionId, sessionId), isNull(alfredConfirmationsTable.usedAt)));
    await tx.insert(alfredConfirmationsTable).values({
      userId,
      sessionId,
      number: input.numero,
      decision: input.decisione === "approva" ? "approve" : "reject",
      note,
      codeHash: hashCode(code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
  });
  return {
    codice: code,
    numero: input.numero,
    tipo: KIND_LABEL[row.kind] ?? row.kind,
    squadra: row.teamName,
    sintesi: row.summary,
    decisione: input.decisione,
  };
}

export async function confirmDecision(userId: number, sessionId: number, code: string) {
  // Consumo con UPDATE condizionato: due conferme concorrenti con lo stesso codice, una sola riesce
  const [used] = await db
    .update(alfredConfirmationsTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(alfredConfirmationsTable.codeHash, hashCode(code)),
        eq(alfredConfirmationsTable.sessionId, sessionId),
        eq(alfredConfirmationsTable.userId, userId),
        isNull(alfredConfirmationsTable.usedAt),
        gt(alfredConfirmationsTable.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!used) throw new ConfirmationError(CONFIRM_MESSAGES.expired);

  // Il limite di 20 decisioni/min e il messaggio d'errore stanno nelle funzioni del centralino
  const out =
    used.decision === "approve"
      ? await approvePending(userId, used.number)
      : await rejectPending(userId, used.number, used.note ?? undefined);
  logger.info({ numero: used.number, esito: out.status }, "decisione via Alfred");
  return {
    numero: out.number,
    stato: out.status,
    risultato: out.result === null ? null : out.result.slice(0, MAX_RESULT),
    errore: out.error,
  };
}
