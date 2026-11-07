import { createHmac, timingSafeEqual } from "node:crypto";
import { db, agentsTable, agentTriggersTable, type AgentTrigger } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger";
import { runBudgetBlock } from "../budget";
import { decryptSecret } from "../secrets";
import { RUN_QUEUE_MESSAGES, scheduleRuns } from "../run-queue";
import { itemKey, matchesFilter, type ExtractConfig } from "./extract";
import { buildTriggerInput } from "./input";
import { TRIGGER_MESSAGES } from "./messages";
import { lockActive, NotActive, QueueFull, queueTriggerRun } from "./queue-run";
import { hashWebhookSecret, secretMatches } from "./secrets";

// Webhook in entrata (spec §5): `POST /api/hooks/:triggerId/:secret`, pubblico. Prima di arrivare qui, nella route,
// il limite di 60/min per innesco (429) e il parser grezzo: un corpo oltre 256 KB riceve 413 dal parser PRIMA del
// controllo di id e segreto. Poi, qui: segreto (id sconosciuto e segreto sbagliato indistinguibili), firma, corpo,
// stato, filtro, tetto, chiave + run in una transazione. Nei log solo id dell'innesco ed esito: mai corpo, segreto o header.

/** Attesa suggerita (secondi) per coda piena e limite di richieste. */
export const WEBHOOK_RETRY_AFTER = 60;
const MAX_DEDUP_LENGTH = 200;
const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;
// Hash di confronto quando l'id non esiste: il controllo del segreto costa sempre lo stesso.
const DUMMY_HASH = hashWebhookSecret("whs_innesco-inesistente");

export type WebhookInput = {
  triggerId: number;
  secret: string;
  contentType: string | undefined;
  rawBody: Buffer;
  signature: string | undefined;
  dedupHeaderValue: (name: string) => string | undefined;
};

export type WebhookResult = { status: number; body: unknown; retryAfter?: number };

type Body = { kind: "json"; value: unknown } | { kind: "form"; value: Record<string, string> } | { kind: "text"; value: string };

const notFound = (): WebhookResult => ({ status: 404, body: { error: TRIGGER_MESSAGES.hookNotFound } });

function done(triggerId: number, outcome: string, result: WebhookResult): WebhookResult {
  logger.info({ triggerId, outcome }, "Webhook dell'innesco");
  return result;
}

/** Firma `sha256=<hex>` = HMAC-SHA256 del corpo grezzo, confrontata a tempo costante. */
function signatureValid(trigger: AgentTrigger, signature: string | undefined, rawBody: Buffer): boolean {
  let key: string;
  try {
    key = decryptSecret(trigger.signingSecretEnc!);
  } catch (err) {
    // Segreto di firma illeggibile (chiave cambiata): si rifiuta, mai il contenuto nel log.
    logger.error({ triggerId: trigger.id, errName: err instanceof Error ? err.name : typeof err }, "Segreto di firma del webhook illeggibile");
    return false;
  }
  const match = signature ? SIGNATURE_RE.exec(signature.trim()) : null;
  if (!match) return false;
  const expected = createHmac("sha256", key).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1]!, "hex"));
}

/** Corpo secondo il tipo: JSON valido, form (oggetto), testo; altri tipi rifiutati. */
function parseBody(contentType: string | undefined, rawBody: Buffer): Body | WebhookResult {
  const media = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const text = rawBody.toString("utf8");
  if (media === "application/json") {
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      return { status: 400, body: { error: TRIGGER_MESSAGES.invalidJson } };
    }
  }
  if (media === "application/x-www-form-urlencoded") {
    return { kind: "form", value: Object.fromEntries(new URLSearchParams(text)) };
  }
  if (media.startsWith("text/")) return { kind: "text", value: text };
  return { status: 415, body: { error: TRIGGER_MESSAGES.unsupportedType } };
}

const isBody = (value: Body | WebhookResult): value is Body => "kind" in value;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Chiave di deduplicazione: valore dell'header configurato (1..200 caratteri); se manca, `id_field`
 * (+ `version_field`) sul corpo JSON; senza nessuno dei due (o senza valore nel corpo) nessuna deduplicazione.
 */
function dedupKey(trigger: AgentTrigger, body: Body, headerValue: WebhookInput["dedupHeaderValue"]): string | null {
  if (trigger.dedupHeader) {
    const value = headerValue(trigger.dedupHeader)?.trim();
    if (value && value.length <= MAX_DEDUP_LENGTH) return value;
  }
  if (trigger.idField && body.kind === "json" && isPlainObject(body.value)) {
    const cfg: ExtractConfig = { itemsPath: null, idField: trigger.idField, versionField: trigger.versionField, cursorField: null, filter: null };
    return itemKey(body.value, cfg);
  }
  return null;
}

export async function handleWebhook(input: WebhookInput): Promise<WebhookResult> {
  const { triggerId } = input;

  // 1. Innesco webhook e segreto: id sconosciuto e segreto sbagliato danno la stessa risposta.
  const [trigger] = Number.isSafeInteger(triggerId) && triggerId > 0
    ? await db
        .select()
        .from(agentTriggersTable)
        .where(and(eq(agentTriggersTable.id, triggerId), eq(agentTriggersTable.kind, "webhook")))
        .limit(1)
    : [];
  const matches = secretMatches(input.secret, trigger?.secretHash ?? DUMMY_HASH);
  if (!trigger || !trigger.secretHash || !matches) return done(triggerId, "not_found", notFound());

  // 2. Firma facoltativa, sul corpo grezzo.
  if (trigger.signingSecretEnc && !signatureValid(trigger, input.signature, input.rawBody)) {
    return done(triggerId, "bad_signature", { status: 401, body: { error: TRIGGER_MESSAGES.badSignature } });
  }

  // Richiesta autenticata: si registra l'arrivo, qualunque sia l'esito.
  await db.update(agentTriggersTable).set({ lastPolledAt: new Date() }).where(eq(agentTriggersTable.id, triggerId));

  // 3. Corpo.
  const body = parseBody(input.contentType, input.rawBody);
  if (!isBody(body)) return done(triggerId, `rejected_${body.status}`, body);

  // 4. Innesco e agente attivi, agente con modello.
  const notActive: WebhookResult = { status: 409, body: { error: TRIGGER_MESSAGES.notActive } };
  if (trigger.status !== "active") return done(triggerId, "not_active", notActive);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, trigger.agentId)).limit(1);
  if (!agent || agent.status !== "active" || agent.aiModelId === null) return done(triggerId, "not_active", notActive);

  // 5. Filtro, solo su corpo JSON o form.
  const filter = (trigger.filter as ExtractConfig["filter"]) ?? null;
  if (filter && body.kind !== "text") {
    const passes = isPlainObject(body.value) && matchesFilter(body.value, filter);
    if (!passes) return done(triggerId, "ignored", { status: 200, body: { ignored: true } });
  }

  // 6. Tetti di spesa: niente si segna come visto.
  const budget = await runBudgetBlock(agent);
  if (budget) return done(triggerId, "budget", { status: 409, body: { error: budget } });

  // 7. Chiave e run nella stessa transazione, con l'innesco ancora attivo e lo stesso segreto (non rigenerato).
  const key = dedupKey(trigger, body, input.dedupHeaderValue);
  const runInput = buildTriggerInput({ kind: "webhook", name: trigger.name, instructions: trigger.instructions, content: body.value });
  let runId: number | null;
  try {
    runId = await db.transaction(async (tx) => {
      await lockActive(tx, trigger.id, eq(agentTriggersTable.secretHash, trigger.secretHash!));
      return queueTriggerRun(tx, { trigger, agent, key, runInput });
    });
  } catch (err) {
    if (err instanceof QueueFull) {
      return done(triggerId, "queue_full", {
        status: 429,
        body: { error: RUN_QUEUE_MESSAGES.queueFull },
        retryAfter: WEBHOOK_RETRY_AFTER,
      });
    }
    if (err instanceof NotActive) return done(triggerId, "not_active", notActive);
    throw err;
  }
  if (runId === null) return done(triggerId, "duplicate", { status: 200, body: { duplicate: true } });
  void scheduleRuns();
  return done(triggerId, "run", { status: 202, body: { runId } });
}
