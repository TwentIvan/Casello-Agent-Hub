import { and, eq, ne, sql } from "drizzle-orm";
import { db, appToolsTable, pendingActionsTable, type PendingActionRow } from "@workspace/db";
import { logger } from "../logger";
import { decryptSecret } from "../secrets";
import { loadAppConnection, toCatalogTool } from "../tools/catalog";
import { executeTool, redact } from "../tools/executor";
import { effectiveLevel } from "../tools/levels";
import { decidePlanItem } from "../teams/plan-decisions";

// Decisione sulle azioni in coda: approvare esegue UNA volta la chiamata memorizzata (argomenti
// originali, senza il modello), rifiutare la chiude. Ogni transizione è un UPDATE condizionato sullo
// stato, così due richieste concorrenti non eseguono due volte.

export type DecideResult = { ok: true; action: PendingActionRow } | { ok: false; status: 400 | 404 | 409 | 500; message: string };

export const ACTION_MESSAGES = {
  notFound: "azione non trovata",
  alreadyDecided: "azione già decisa",
  notExecutable: "lo strumento non può più essere eseguito da Casello",
  userTokenRequired: "serve il token dell'utente dell'app",
  internal: "errore interno nell'esecuzione dell'azione",
  internalFinish: "errore interno: esito dell'azione non registrato",
  uncertain: "esito incerto: verifica sul servizio",
} as const;

const fail = (status: 400 | 404 | 409 | 500, message: string): DecideResult => ({ ok: false, status, message });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tutti i valori scalari contenuti in `value`, come testo. */
function collectScalars(value: unknown, out: string[]): void {
  if (Array.isArray(value)) for (const v of value) collectScalars(v, out);
  else if (isPlainObject(value)) for (const v of Object.values(value)) collectScalars(v, out);
  else if (value !== null && value !== undefined) out.push(String(value));
}

/** Valori degli argomenti marcati `x-sensitive` nello schema (anche annidati), come testo. */
export function sensitiveValues(schema: unknown, args: unknown, out: string[] = []): string[] {
  if (!isPlainObject(schema)) return out;
  if (schema["x-sensitive"] === true) {
    collectScalars(args, out);
    return out;
  }
  const props = schema["properties"];
  if (!isPlainObject(props) || !isPlainObject(args)) return out;
  for (const [key, sub] of Object.entries(props)) {
    if (Object.hasOwn(args, key)) sensitiveValues(sub, args[key], out);
  }
  return out;
}

async function finish(id: number, set: { status: "done" | "failed"; result?: string | null; errorMessage?: string | null }) {
  const [row] = await db
    .update(pendingActionsTable)
    .set({ ...set, finishedAt: new Date() })
    .where(eq(pendingActionsTable.id, id))
    .returning();
  return row;
}

export async function approveAction(
  userId: number,
  number: number,
  opts: { userToken?: string } = {},
): Promise<DecideResult> {
  const [action] = await db
    .select()
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, number)))
    .limit(1);
  if (!action) return fail(404, ACTION_MESSAGES.notFound);
  if (action.status !== "pending") return fail(409, ACTION_MESSAGES.alreadyDecided);

  // Piani e modifiche del piano non hanno tool né app: si decidono sul PLAN della squadra (nessun token utente)
  if (action.kind !== "action") return decidePlanItem(action, true, null);
  const { toolId, appId } = action;
  if (toolId === null || appId === null) return fail(409, ACTION_MESSAGES.notExecutable);

  const [toolRow] = await db.select().from(appToolsTable).where(eq(appToolsTable.id, toolId)).limit(1);
  const tool = toolRow ? toCatalogTool(toolRow) : null;
  if (
    !tool ||
    tool.status !== "active" ||
    effectiveLevel(tool) === "L3" ||
    (tool.kind !== "http" && tool.kind !== "mcp")
  ) {
    return fail(409, ACTION_MESSAGES.notExecutable);
  }
  if (tool.identity === "user" && !opts.userToken) return fail(400, ACTION_MESSAGES.userTokenRequired);

  // Prenotazione: una sola richiesta passa da pending a executing
  const [claimed] = await db
    .update(pendingActionsTable)
    .set({ status: "executing", decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(pendingActionsTable.id, action.id), eq(pendingActionsTable.status, "pending")))
    .returning();
  if (!claimed) return fail(409, ACTION_MESSAGES.alreadyDecided);

  // `called` diventa vero appena parte la chiamata al servizio: da lì in poi un errore non prova che
  // l'azione non sia avvenuta (es. fallisce solo la scrittura dell'esito) e l'esito è incerto.
  let called = false;
  try {
    const args = JSON.parse(decryptSecret(action.argsEnc)) as unknown;
    const conn = await loadAppConnection(appId);
    called = true;
    const out = await executeTool({
      conn,
      tool,
      args,
      ...(tool.identity === "user" && opts.userToken ? { userToken: opts.userToken } : {}),
    });
    // L'esecutore oscura già le credenziali; qui si tolgono anche i valori degli argomenti sensibili
    const secrets = sensitiveValues(tool.paramsSchema, args);
    const content = redact(out.content, secrets);
    const row = out.ok
      ? await finish(action.id, { status: "done", result: content })
      : await finish(action.id, { status: "failed", errorMessage: content });
    return row ? { ok: true, action: row } : fail(404, ACTION_MESSAGES.notFound);
  } catch (err) {
    // Solo il nome dell'errore: il messaggio potrebbe contenere argomenti o credenziali
    logger.error({ actionId: action.id, errName: err instanceof Error ? err.name : "unknown" }, "Esecuzione dell'azione in coda non riuscita");
    try {
      const row = await finish(action.id, {
        status: "failed",
        errorMessage: called ? ACTION_MESSAGES.uncertain : ACTION_MESSAGES.internal,
      });
      return row ? { ok: true, action: row } : fail(404, ACTION_MESSAGES.notFound);
    } catch (finishErr) {
      // La riga resta `executing`: all'avvio diventa «incerto» (failInterruptedActions)
      logger.error(
        { actionId: action.id, errName: finishErr instanceof Error ? finishErr.name : "unknown" },
        "Esito dell'azione in coda non registrato",
      );
      return fail(500, ACTION_MESSAGES.internalFinish);
    }
  }
}

export async function rejectAction(userId: number, number: number, note: string | null): Promise<DecideResult> {
  const [planItem] = await db
    .select()
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, number), ne(pendingActionsTable.kind, "action")))
    .limit(1);
  if (planItem) return decidePlanItem(planItem, false, note);
  const [row] = await db
    .update(pendingActionsTable)
    .set({ status: "rejected", decidedBy: userId, decidedAt: new Date(), decisionNote: note })
    .where(
      and(
        eq(pendingActionsTable.userId, userId),
        eq(pendingActionsTable.number, number),
        eq(pendingActionsTable.status, "pending"),
      ),
    )
    .returning();
  if (row) return { ok: true, action: row };
  // Nessuna riga: non esiste (404) o non è più in attesa (409)
  const [existing] = await db
    .select({ id: pendingActionsTable.id })
    .from(pendingActionsTable)
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, number)))
    .limit(1);
  return existing ? fail(409, ACTION_MESSAGES.alreadyDecided) : fail(404, ACTION_MESSAGES.notFound);
}

/** All'avvio: le azioni rimaste in esecuzione hanno un esito incerto (il servizio può averle eseguite). */
export async function failInterruptedActions(): Promise<number> {
  const rows = await db
    .update(pendingActionsTable)
    .set({ status: "failed", errorMessage: ACTION_MESSAGES.uncertain, finishedAt: sql`now()` })
    .where(eq(pendingActionsTable.status, "executing"))
    .returning({ id: pendingActionsTable.id });
  return rows.length;
}
