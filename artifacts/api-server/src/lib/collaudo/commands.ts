// Coda dei comandi dall'agente collaudatore al runner: l'agente accoda e attende il risultato, il runner chiede il
// prossimo comando (attesa lunga) e riferisce. Gli avvisi sono in memoria (uno per collaudo e uno per comando) con una
// rilettura di riserva ogni pochi secondi, per il caso di più container.

import { EventEmitter } from "node:events";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, releaseTestCommandsTable } from "@workspace/db";
import { redactCredentials } from "../memory/credentials";

export const MAX_OUTPUT_CHARS = 8_000;
const RECHECK_MS = 5_000;
const EXPIRED_OUTPUT = "comando scaduto";
const ABORTED_OUTPUT = "comando annullato";

const events = new EventEmitter();
events.setMaxListeners(0);
const testEvent = (testId: number) => `test:${testId}`;
const commandEvent = (commandId: number) => `cmd:${commandId}`;

/** Attende fino a `ms` un avviso; subito vero se è già arrivato dopo l'iscrizione. */
function subscribe(name: string) {
  let fired = false;
  let wake: (() => void) | null = null;
  const onEvent = () => {
    fired = true;
    wake?.();
  };
  events.on(name, onEvent);
  return {
    wait(ms: number, signal?: AbortSignal): Promise<boolean> {
      return new Promise((resolve) => {
        if (fired) {
          fired = false;
          return resolve(true);
        }
        if (signal?.aborted || ms <= 0) return resolve(false);
        const done = (woken: boolean) => {
          clearTimeout(timer);
          wake = null;
          signal?.removeEventListener("abort", onAbort);
          resolve(woken);
        };
        const onAbort = () => done(false);
        const timer = setTimeout(() => done(false), ms);
        wake = () => {
          fired = false;
          done(true);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    close() {
      events.off(name, onEvent);
      wake = null;
    },
  };
}

/** Accoda un comando per il runner e sveglia il suo `next` in attesa. */
export async function enqueueCommand(testId: number, kind: "shell" | "browser", args: Record<string, unknown>): Promise<number> {
  const [row] = await db.insert(releaseTestCommandsTable).values({ testId, kind, args, status: "pending" }).returning({ id: releaseTestCommandsTable.id });
  events.emit(testEvent(testId));
  return row!.id;
}

/** Il più vecchio comando `pending` del collaudo, segnato `sent` con UPDATE condizionato (una consegna sola). */
async function takePending(testId: number): Promise<{ id: number; kind: string; args: unknown } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const [next] = await db
      .select({ id: releaseTestCommandsTable.id })
      .from(releaseTestCommandsTable)
      .where(and(eq(releaseTestCommandsTable.testId, testId), eq(releaseTestCommandsTable.status, "pending")))
      .orderBy(asc(releaseTestCommandsTable.id))
      .limit(1);
    if (!next) return null;
    const [taken] = await db
      .update(releaseTestCommandsTable)
      .set({ status: "sent", sentAt: new Date() })
      .where(and(eq(releaseTestCommandsTable.id, next.id), eq(releaseTestCommandsTable.status, "pending")))
      .returning({ id: releaseTestCommandsTable.id, kind: releaseTestCommandsTable.kind, args: releaseTestCommandsTable.args });
    if (taken) return taken;
  }
  return null;
}

/** Prossimo comando per il runner: attesa lunga fino a `waitMs`, null se non ne arriva nessuno. */
export async function nextCommand(testId: number, waitMs: number, signal?: AbortSignal): Promise<{ id: number; kind: string; args: unknown } | null> {
  const subscription = subscribe(testEvent(testId));
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      // Runner già disconnesso: non si prende nulla, il comando resta `pending` per il prossimo `next`
      if (signal?.aborted) return null;
      const found = await takePending(testId);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return null;
      await subscription.wait(Math.min(left, RECHECK_MS), signal);
    }
  } finally {
    subscription.close();
  }
}

/** Riporta a `pending` un comando consegnato a una connessione ormai chiusa e sveglia il prossimo `next`. */
export async function releaseCommand(testId: number, commandId: number): Promise<boolean> {
  const rows = await db
    .update(releaseTestCommandsTable)
    .set({ status: "pending", sentAt: null })
    .where(
      and(
        eq(releaseTestCommandsTable.id, commandId),
        eq(releaseTestCommandsTable.testId, testId),
        eq(releaseTestCommandsTable.status, "sent"),
      ),
    )
    .returning({ id: releaseTestCommandsTable.id });
  if (rows.length === 0) return false;
  events.emit(testEvent(testId));
  return true;
}

/** Uscita ripulita: le parole che sembrano credenziali diventano `***`, poi taglio a 8 000 caratteri. */
export function cleanOutput(text: string): string {
  const redacted = redactCredentials(text);
  return redacted.length > MAX_OUTPUT_CHARS ? redacted.slice(0, MAX_OUTPUT_CHARS) : redacted;
}

/** Salva il risultato di un comando consegnato; false se il comando non è del collaudo o non è `sent`. */
export async function saveCommandResult(testId: number, commandId: number, r: { ok: boolean; output: string }): Promise<boolean> {
  const [row] = await db
    .update(releaseTestCommandsTable)
    .set({ status: r.ok ? "done" : "failed", output: cleanOutput(r.output), finishedAt: new Date() })
    .where(
      and(
        eq(releaseTestCommandsTable.id, commandId),
        eq(releaseTestCommandsTable.testId, testId),
        eq(releaseTestCommandsTable.status, "sent"),
      ),
    )
    .returning({ id: releaseTestCommandsTable.id });
  if (!row) return false;
  events.emit(commandEvent(commandId));
  return true;
}

/** Segna `expired` un comando ancora aperto; vero se l'ha chiuso questa chiamata. */
async function expireCommand(commandId: number): Promise<boolean> {
  const rows = await db
    .update(releaseTestCommandsTable)
    .set({ status: "expired", output: EXPIRED_OUTPUT, finishedAt: new Date() })
    .where(and(eq(releaseTestCommandsTable.id, commandId), inArray(releaseTestCommandsTable.status, ["pending", "sent"])))
    .returning({ id: releaseTestCommandsTable.id });
  return rows.length > 0;
}

/** Attende il risultato di un comando; scaduto o annullato → il comando diventa `expired` e `{ok:false}`. */
export async function waitCommandResult(
  commandId: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  const subscription = subscribe(commandEvent(commandId));
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const [row] = await db
        .select({ status: releaseTestCommandsTable.status, output: releaseTestCommandsTable.output })
        .from(releaseTestCommandsTable)
        .where(eq(releaseTestCommandsTable.id, commandId));
      if (!row) return { ok: false, output: EXPIRED_OUTPUT };
      if (row.status === "done" || row.status === "failed") return { ok: row.status === "done", output: row.output ?? "" };
      if (row.status === "expired") return { ok: false, output: row.output ?? EXPIRED_OUTPUT };
      const left = deadline - Date.now();
      if (left <= 0) {
        await expireCommand(commandId);
        return { ok: false, output: EXPIRED_OUTPUT };
      }
      if (signal?.aborted) {
        await expireCommand(commandId);
        return { ok: false, output: ABORTED_OUTPUT };
      }
      await subscription.wait(Math.min(left, 2_000), signal);
    }
  } finally {
    subscription.close();
  }
}

/** Chiude come `expired` i comandi ancora aperti del collaudo (a fine collaudo) e sveglia chi li attende. */
export async function expireOpenCommands(testId: number): Promise<void> {
  const rows = await db
    .update(releaseTestCommandsTable)
    .set({ status: "expired", output: EXPIRED_OUTPUT, finishedAt: new Date() })
    .where(and(eq(releaseTestCommandsTable.testId, testId), inArray(releaseTestCommandsTable.status, ["pending", "sent"])))
    .returning({ id: releaseTestCommandsTable.id });
  for (const r of rows) events.emit(commandEvent(r.id));
}
