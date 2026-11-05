import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, alfredConfirmationsTable, alfredSessionsTable, appToolsTable, pendingActionsTable, teamInstancesTable } from "@workspace/db";
import { approvePending, needsUserToken, rejectPending } from "../teams/centralino";
import { logger } from "../logger";
import { AlfredError } from "./gemini";

// Conferma a doppio passo (spec §4): `prepareDecision` non decide nulla e consegna un codice di 6 cifre valido 60 s,
// `confirmDecision` lo consuma una volta sola e solo allora approva o rifiuta. Del codice si salva solo l'hash SHA-256.

export const CONFIRM_MESSAGES = {
  notPending: "voce non in attesa",
  needsToken: "questa voce va approvata dalla console: serve il token dell'app",
  failed: "approvata ma l'esecuzione non è riuscita: controlla in console",
  expired: "conferma scaduta: ripeti la richiesta",
  noteWithApprove: "la nota si può dare solo con il rifiuto",
} as const;

/** Errore con messaggio fisso da restituire allo strumento. */
export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationError";
  }
}

const CODE_TTL_MS = 60_000;
// Una conferma arrivata prima di 2 s dalla preparazione non può essere una risposta dell'utente
const MIN_CONFIRM_DELAY_MS = 2_000;

/** Un errore del DB sulle conferme non deve far arrivare l'hash del codice nei log: si registra solo il nome. */
async function guardDb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AlfredError) throw err;
    logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Scrittura della conferma di Alfred non riuscita");
    throw new AlfredError("errore interno", 500);
  }
}

const KIND_LABEL: Record<string, string> = { action: "azione", plan: "piano", plan_change: "modifica del piano" };

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

type Executor = Pick<typeof db, "select" | "update">;

/** Segna usate le conferme aperte della sessione, con la riga della sessione bloccata (serializza le preparazioni). */
async function closeOpenConfirmations(sessionId: number, executor?: Executor): Promise<void> {
  const run = async (tx: Executor) => {
    await tx.select({ id: alfredSessionsTable.id }).from(alfredSessionsTable).where(eq(alfredSessionsTable.id, sessionId)).for("update");
    await tx
      .update(alfredConfirmationsTable)
      .set({ usedAt: new Date() })
      .where(and(eq(alfredConfirmationsTable.sessionId, sessionId), isNull(alfredConfirmationsTable.usedAt)));
  };
  if (executor) await run(executor);
  else await db.transaction(run);
}

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

  // Ogni preparazione, anche se fallisce, chiude le conferme aperte: un codice vecchio non vale dopo un nuovo «sì»
  await guardDb(() => closeOpenConfirmations(sessionId));
  if (note !== null && input.decisione === "approva") throw new ConfirmationError(CONFIRM_MESSAGES.noteWithApprove);

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
  if (!row) throw new ConfirmationError(CONFIRM_MESSAGES.notPending);
  if (row.status !== "pending") throw new ConfirmationError(CONFIRM_MESSAGES.notPending);
  if (input.decisione === "approva" && needsUserToken(row.kind, row.identity)) {
    throw new ConfirmationError(CONFIRM_MESSAGES.needsToken);
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await guardDb(() => db.transaction(async (tx) => {
    // La riga della sessione serializza due preparazioni concorrenti: resta aperta una sola conferma
    const now = new Date();
    await closeOpenConfirmations(sessionId, tx);
    await tx.insert(alfredConfirmationsTable).values({
      userId,
      sessionId,
      number: input.numero,
      decision: input.decisione === "approva" ? "approve" : "reject",
      note,
      codeHash: hashCode(code),
      // Scritto dall'API: il default now() del DB usa il fuso della sessione e falserebbe il confronto con Date.now()
      createdAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    });
  }));
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
  const [used] = await guardDb(() => db
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
    .returning());
  if (!used) throw new ConfirmationError(CONFIRM_MESSAGES.expired);
  // Troppo presto: il codice è già consumato (invalidato), l'utente deve ripetere la richiesta
  if (Date.now() - used.createdAt.getTime() < MIN_CONFIRM_DELAY_MS) throw new ConfirmationError(CONFIRM_MESSAGES.expired);

  // Il limite di 20 decisioni/min e il messaggio d'errore stanno nelle funzioni del centralino
  const out =
    used.decision === "approve"
      ? await approvePending(userId, used.number)
      : await rejectPending(userId, used.number, used.note ?? undefined);
  logger.info({ numero: used.number, esito: out.status }, "decisione via Alfred");
  // Esito breve da leggere ad alta voce; il testo dell'app non entra mai nella risposta
  const esito = out.status === "rejected" ? "rifiutata" : out.status === "failed" ? CONFIRM_MESSAGES.failed : "approvata";
  return { numero: out.number, esito };
}
