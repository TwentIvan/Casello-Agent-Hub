import {
  db,
  agentsTable,
  agentTriggersTable,
  appToolsTable,
  triggerSeenItemsTable,
  type Agent,
  type AgentTrigger,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { encryptSecret } from "../secrets";
import { isUniqueViolation } from "../pg-errors";
import { toCatalogTool } from "../tools/catalog";
import { validateArgs } from "../tools/definition";
import type { CatalogTool } from "../tools/types";
import { validateTriggerConfig, type NormalizedTriggerConfig, type TriggerConfigInput, type TriggerFilter } from "./config";
import { toolUsableByTrigger } from "./eligibility";
import { extractItems } from "./extract";
import { TRIGGER_MESSAGES } from "./messages";
import { callTriggerTool, cursorArg, uniqueByKey } from "./poller";
import { generateWebhookSecret, webhookUrl } from "./secrets";

// Gestione degli inneschi (spec §7): creazione, modifica, pausa e ripresa, segreti del webhook e «Prova».
// Le regole di forma stanno in `config.ts`; qui tool idoneo (§4.1), argomenti conformi a `params_schema`,
// limiti di quantità (§3.4) e unicità del nome. Errori con messaggi fissi (`TRIGGER_MESSAGES`).

export const MAX_TRIGGERS_PER_AGENT = 10;
export const MAX_TRIGGERS_PER_USER = 50;
const TEST_MAX_ITEMS = 20;
const PREVIEW_CHARS = 200;
const MIN_SIGNING_SECRET = 16;
const MAX_SIGNING_SECRET = 200;
const NAME_CONSTRAINT = "agent_triggers_agent_name_key";

type Fail = { ok: false; status: 400 | 404 | 409; error: string };
export type ServiceResult<T> = { ok: true; value: T } | Fail;

const fail = (status: Fail["status"], error: string): Fail => ({ ok: false, status, error });
const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value });

/** Campi modificabili con PATCH: assente = invariato, null = tolto. Il tipo non cambia. */
export type TriggerPatchInput = Partial<Omit<TriggerConfigInput, "kind" | "name">> & { name?: string };

export type TriggerTestResult = {
  items: Array<{ key: string; isNew: boolean; preview: string }>;
  total: number;
  newCount: number;
  errors: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Innesco per l'API: mai l'hash del segreto dell'URL né il segreto di firma, solo se quest'ultimo c'è. */
export function serializeTrigger(row: AgentTrigger) {
  const { secretHash: _secretHash, signingSecretEnc, args, filter, ...rest } = row;
  return {
    ...rest,
    args: isPlainObject(args) ? args : {},
    filter: isPlainObject(filter) ? (filter as TriggerFilter) : null,
    signingSecretSet: signingSecretEnc != null,
  };
}

async function loadAgent(id: number): Promise<Agent | null> {
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  return agent ?? null;
}

export async function loadTrigger(id: number): Promise<AgentTrigger | null> {
  const [row] = await db.select().from(agentTriggersTable).where(eq(agentTriggersTable.id, id)).limit(1);
  return row ?? null;
}

/** Tool idoneo per l'agente (§4.1) o null. */
async function usableTool(toolId: number | null, agent: Agent): Promise<CatalogTool | null> {
  if (toolId === null) return null;
  const [row] = await db.select().from(appToolsTable).where(eq(appToolsTable.id, toolId)).limit(1);
  return row && toolUsableByTrigger(row, agent.appId) ? toCatalogTool(row) : null;
}

/** Il parametro del cursore deve poter stare negli argomenti: dichiarato, o ammesso da uno schema aperto. */
function cursorParamAllowed(tool: CatalogTool, param: string): boolean {
  const props = tool.paramsSchema["properties"];
  if (isPlainObject(props) && Object.hasOwn(props, param)) return true;
  return tool.paramsSchema["additionalProperties"] !== false;
}

/** Regole oltre la forma, per la sorveglianza: tool idoneo e argomenti conformi a `params_schema`. */
async function checkPollTool(agent: Agent, cfg: NormalizedTriggerConfig): Promise<ServiceResult<CatalogTool | null>> {
  if (cfg.kind !== "poll") return ok(null);
  const tool = await usableTool(cfg.toolId, agent);
  if (!tool) return fail(400, TRIGGER_MESSAGES.toolNotUsable);
  // Il testo del validatore non esce: messaggio fisso.
  if (validateArgs(tool.paramsSchema, cfg.args) !== null) return fail(400, TRIGGER_MESSAGES.invalidArgs);
  if (cfg.cursorParam && !cursorParamAllowed(tool, cfg.cursorParam)) return fail(400, TRIGGER_MESSAGES.invalidArgs);
  return ok(tool);
}

/** Configurazione completa e controllata per un agente: forma, poi tool e argomenti. */
async function checkConfig(agent: Agent, input: TriggerConfigInput): Promise<ServiceResult<{ cfg: NormalizedTriggerConfig; tool: CatalogTool | null }>> {
  const shape = validateTriggerConfig(input);
  if (!shape.ok) return fail(400, shape.error);
  const tool = await checkPollTool(agent, shape.value);
  if (!tool.ok) return tool;
  return ok({ cfg: shape.value, tool: tool.value });
}

/** Colonne della configurazione normalizzata (comuni a creazione e modifica). */
function configColumns(cfg: NormalizedTriggerConfig) {
  return {
    name: cfg.name,
    instructions: cfg.instructions,
    toolId: cfg.toolId,
    args: cfg.args,
    itemsPath: cfg.itemsPath,
    idField: cfg.idField,
    versionField: cfg.versionField,
    cursorParam: cfg.cursorParam,
    cursorField: cfg.cursorField,
    filter: cfg.filter,
    intervalSeconds: cfg.intervalSeconds,
    dedupHeader: cfg.dedupHeader,
  };
}

class TooMany extends Error {}
class AgentGone extends Error {}

/**
 * Crea un innesco in pausa. La riga dell'agente bloccata serializza le creazioni sullo stesso agente (limite di 10);
 * il limite di 50 per utente (`created_by`) si conta nella stessa transazione. Per il webhook restituisce l'URL con
 * il segreto, l'unica volta in cui si vede.
 */
export async function createTrigger(
  agentId: number,
  userId: number,
  input: TriggerConfigInput,
): Promise<ServiceResult<{ trigger: AgentTrigger; webhookUrl: string | null }>> {
  const agent = await loadAgent(agentId);
  if (!agent) return fail(404, TRIGGER_MESSAGES.agentNotFound);
  const checked = await checkConfig(agent, input);
  if (!checked.ok) return checked;
  const { cfg } = checked.value;

  const secret = cfg.kind === "webhook" ? generateWebhookSecret() : null;
  try {
    const trigger = await db.transaction(async (tx) => {
      const [locked] = await tx.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.id, agentId)).for("update");
      if (!locked) throw new AgentGone();
      const [{ perAgent }] = await tx
        .select({ perAgent: sql<number>`count(*)::int` })
        .from(agentTriggersTable)
        .where(eq(agentTriggersTable.agentId, agentId));
      if (perAgent >= MAX_TRIGGERS_PER_AGENT) throw new TooMany();
      const [{ perUser }] = await tx
        .select({ perUser: sql<number>`count(*)::int` })
        .from(agentTriggersTable)
        .where(eq(agentTriggersTable.createdBy, userId));
      if (perUser >= MAX_TRIGGERS_PER_USER) throw new TooMany();
      const [row] = await tx
        .insert(agentTriggersTable)
        .values({
          agentId,
          kind: cfg.kind,
          status: "paused",
          createdBy: userId,
          ...configColumns(cfg),
          nextPollAt: cfg.kind === "poll" ? new Date() : null,
          secretHash: secret?.hash ?? null,
        })
        .returning();
      return row!;
    });
    return ok({ trigger, webhookUrl: secret ? webhookUrl(trigger.id, secret.secret) : null });
  } catch (err) {
    if (err instanceof AgentGone) return fail(404, TRIGGER_MESSAGES.agentNotFound);
    if (err instanceof TooMany) return fail(409, TRIGGER_MESSAGES.tooMany);
    if (isUniqueViolation(err, NAME_CONSTRAINT)) return fail(409, TRIGGER_MESSAGES.nameTaken);
    throw err;
  }
}

/** Configurazione attuale dell'innesco come ingresso della validazione: solo i campi del suo tipo. */
function currentConfig(row: AgentTrigger): TriggerConfigInput {
  const common = {
    kind: row.kind,
    name: row.name,
    instructions: row.instructions,
    itemsPath: row.itemsPath,
    idField: row.idField,
    versionField: row.versionField,
    filter: isPlainObject(row.filter) ? (row.filter as TriggerFilter) : null,
  };
  if (row.kind === "webhook") return { ...common, dedupHeader: row.dedupHeader };
  return {
    ...common,
    toolId: row.toolId,
    args: isPlainObject(row.args) ? row.args : {},
    cursorParam: row.cursorParam,
    cursorField: row.cursorField,
    intervalSeconds: row.intervalSeconds,
  };
}

const PATCH_KEYS = [
  "name",
  "instructions",
  "toolId",
  "args",
  "itemsPath",
  "idField",
  "versionField",
  "cursorParam",
  "cursorField",
  "filter",
  "intervalSeconds",
  "dedupHeader",
] as const;

/** Campi che cambiano gli elementi letti o la loro chiave: la linea di partenza si rifà. */
function needsNewBaseline(row: AgentTrigger, cfg: NormalizedTriggerConfig): boolean {
  return (
    row.toolId !== cfg.toolId ||
    row.itemsPath !== cfg.itemsPath ||
    row.idField !== cfg.idField ||
    row.versionField !== cfg.versionField ||
    JSON.stringify(isPlainObject(row.filter) ? row.filter : null) !== JSON.stringify(cfg.filter)
  );
}

class TriggerGone extends Error {}

/**
 * Modifica un innesco. Cambiare tool, `itemsPath`, `idField`, `versionField` o `filter` riporta `baselineDone = false`,
 * azzera il cursore e cancella le chiavi viste nella stessa transazione (riga dell'innesco bloccata).
 */
export async function updateTrigger(id: number, patch: TriggerPatchInput): Promise<ServiceResult<AgentTrigger>> {
  const current = await loadTrigger(id);
  if (!current) return fail(404, TRIGGER_MESSAGES.notFound);
  const agent = await loadAgent(current.agentId);
  if (!agent) return fail(404, TRIGGER_MESSAGES.notFound);

  const merged: Record<string, unknown> = { ...currentConfig(current) };
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  const checked = await checkConfig(agent, merged as TriggerConfigInput);
  if (!checked.ok) return checked;
  const { cfg } = checked.value;

  try {
    const updated = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(agentTriggersTable).where(eq(agentTriggersTable.id, id)).for("update");
      if (!locked) throw new TriggerGone();
      const reset = needsNewBaseline(locked, cfg);
      if (reset) await tx.delete(triggerSeenItemsTable).where(eq(triggerSeenItemsTable.triggerId, id));
      const [row] = await tx
        .update(agentTriggersTable)
        .set({
          ...configColumns(cfg),
          ...(reset ? { baselineDone: false, cursorValue: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(agentTriggersTable.id, id))
        .returning();
      return row!;
    });
    return ok(updated);
  } catch (err) {
    if (err instanceof TriggerGone) return fail(404, TRIGGER_MESSAGES.notFound);
    if (isUniqueViolation(err, NAME_CONSTRAINT)) return fail(409, TRIGGER_MESSAGES.nameTaken);
    throw err;
  }
}

export async function deleteTrigger(id: number): Promise<boolean> {
  const rows = await db.delete(agentTriggersTable).where(eq(agentTriggersTable.id, id)).returning({ id: agentTriggersTable.id });
  return rows.length > 0;
}

export async function pauseTrigger(id: number): Promise<AgentTrigger | null> {
  const [row] = await db
    .update(agentTriggersTable)
    .set({ status: "paused", updatedAt: new Date() })
    .where(eq(agentTriggersTable.id, id))
    .returning();
  return row ?? null;
}

/** Attiva o riprende: errori azzerati e, per la sorveglianza, giro subito. */
export async function resumeTrigger(id: number): Promise<AgentTrigger | null> {
  const [row] = await db
    .update(agentTriggersTable)
    .set({
      status: "active",
      consecutiveErrors: 0,
      lastError: null,
      nextPollAt: sql`case when ${agentTriggersTable.kind} = 'poll' then now() else ${agentTriggersTable.nextPollAt} end`,
      updatedAt: new Date(),
    })
    .where(eq(agentTriggersTable.id, id))
    .returning();
  return row ?? null;
}

/** Nuovo segreto dell'URL del webhook: il precedente smette di valere. */
export async function regenerateWebhookSecret(id: number): Promise<ServiceResult<string>> {
  const { secret, hash } = generateWebhookSecret();
  const [row] = await db
    .update(agentTriggersTable)
    .set({ secretHash: hash, updatedAt: new Date() })
    .where(and(eq(agentTriggersTable.id, id), eq(agentTriggersTable.kind, "webhook")))
    .returning({ id: agentTriggersTable.id });
  if (row) return ok(webhookUrl(row.id, secret));
  return (await loadTrigger(id)) ? fail(400, TRIGGER_MESSAGES.webhookOnly) : fail(404, TRIGGER_MESSAGES.notFound);
}

/** Segreto di firma (16..200 caratteri) cifrato, o tolto con null. */
export async function setSigningSecret(id: number, secret: string | null): Promise<ServiceResult<AgentTrigger>> {
  const current = await loadTrigger(id);
  if (!current) return fail(404, TRIGGER_MESSAGES.notFound);
  if (current.kind !== "webhook") return fail(400, TRIGGER_MESSAGES.webhookOnly);
  if (secret !== null && (secret.length < MIN_SIGNING_SECRET || secret.length > MAX_SIGNING_SECRET)) {
    return fail(400, TRIGGER_MESSAGES.invalidSigningSecret);
  }
  const [row] = await db
    .update(agentTriggersTable)
    .set({ signingSecretEnc: secret === null ? null : encryptSecret(secret), updatedAt: new Date() })
    .where(eq(agentTriggersTable.id, id))
    .returning();
  return row ? ok(row) : fail(404, TRIGGER_MESSAGES.notFound);
}

/** Anteprima di un elemento: JSON tagliato a 200 caratteri, senza lasciare a metà una coppia surrogata. */
function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  if (text.length <= PREVIEW_CHARS) return text;
  let cut = text.slice(0, PREVIEW_CHARS);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Esegue la prova: chiama il tool come un giro, estrae gli elementi e dice quali chiavi non sono ancora viste.
 * Non crea run, non scrive chiavi né cursore.
 */
async function runTest(input: {
  appId: number;
  tool: CatalogTool;
  args: Record<string, unknown>;
  cfg: Pick<NormalizedTriggerConfig, "itemsPath" | "idField" | "versionField" | "cursorField" | "filter">;
  triggerId: number | null;
}): Promise<TriggerTestResult> {
  const empty = (error: string): TriggerTestResult => ({ items: [], total: 0, newCount: 0, errors: [error] });
  const call = await callTriggerTool(input.appId, input.tool, input.args);
  if (!call.ok) return empty(call.error);
  const extracted = extractItems(call.response, {
    itemsPath: input.cfg.itemsPath,
    idField: input.cfg.idField ?? "id",
    versionField: input.cfg.versionField,
    cursorField: input.cfg.cursorField,
    filter: input.cfg.filter,
  });
  if (!extracted.ok) return empty(TRIGGER_MESSAGES.listNotFound);
  const items = uniqueByKey(extracted.items);

  const known = new Set<string>();
  if (input.triggerId !== null && items.length > 0) {
    const rows = await db
      .select({ key: triggerSeenItemsTable.itemKey })
      .from(triggerSeenItemsTable)
      .where(
        and(
          eq(triggerSeenItemsTable.triggerId, input.triggerId),
          inArray(
            triggerSeenItemsTable.itemKey,
            items.map((i) => i.key),
          ),
        ),
      );
    for (const r of rows) known.add(r.key);
  }
  return {
    items: items.slice(0, TEST_MAX_ITEMS).map((i) => ({ key: i.key, isNew: !known.has(i.key), preview: preview(i.value) })),
    total: items.length,
    newCount: items.filter((i) => !known.has(i.key)).length,
    errors: extracted.skipped > 0 ? [`${TRIGGER_MESSAGES.itemsSkipped}: ${extracted.skipped}`] : [],
  };
}

/** «Prova» di una configurazione, anche non salvata: tutti gli elementi risultano nuovi. */
export async function testTriggerConfig(agentId: number, input: TriggerConfigInput): Promise<ServiceResult<TriggerTestResult>> {
  const agent = await loadAgent(agentId);
  if (!agent) return fail(404, TRIGGER_MESSAGES.agentNotFound);
  if (input.kind !== "poll") return fail(400, TRIGGER_MESSAGES.pollOnly);
  const checked = await checkConfig(agent, input);
  if (!checked.ok) return checked;
  const { cfg, tool } = checked.value;
  return ok(await runTest({ appId: agent.appId, tool: tool!, args: cfg.args, cfg, triggerId: null }));
}

/** «Prova» di un innesco salvato: argomenti e cursore salvati, `isNew` rispetto alle chiavi viste. */
export async function testSavedTrigger(id: number): Promise<ServiceResult<TriggerTestResult>> {
  const trigger = await loadTrigger(id);
  if (!trigger) return fail(404, TRIGGER_MESSAGES.notFound);
  if (trigger.kind !== "poll") return fail(400, TRIGGER_MESSAGES.pollOnly);
  const agent = await loadAgent(trigger.agentId);
  if (!agent) return fail(404, TRIGGER_MESSAGES.notFound);
  const tool = await usableTool(trigger.toolId, agent);
  if (!tool) return fail(400, TRIGGER_MESSAGES.toolNoLonger);
  const args: Record<string, unknown> = { ...(isPlainObject(trigger.args) ? trigger.args : {}) };
  if (trigger.cursorParam && trigger.cursorValue !== null) {
    args[trigger.cursorParam] = cursorArg(tool, trigger.cursorParam, trigger.cursorValue);
  }
  const cfg = {
    itemsPath: trigger.itemsPath,
    idField: trigger.idField,
    versionField: trigger.versionField,
    cursorField: trigger.cursorField,
    filter: isPlainObject(trigger.filter) ? (trigger.filter as TriggerFilter) : null,
  };
  return ok(await runTest({ appId: agent.appId, tool, args, cfg, triggerId: trigger.id }));
}
