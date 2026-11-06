// Schede dei personaggi: registrazione durante il turno (`recordProposal`), forma pubblica (`toProposalView`) e
// decisione (`decideCharacterProposal`). Accettare una scheda di Lucius applica la proposta in una transazione con la
// scheda e l'oggetto bloccati e l'impronta ricontrollata; la scheda `decision` di Alfred decide una voce della coda.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  agentsTable,
  appToolsTable,
  characterConversationsTable,
  characterProposalsTable,
  pendingActionsTable,
  skillsTable,
  teamTemplatesTable,
  type CharacterConversation,
  type CharacterProposal,
} from "@workspace/db";
import { ACTION_MESSAGES, approveAction, rejectAction } from "../actions/decide";
import { AgentError, createAreaAgent, setAgentTools, updateAgentPrompt } from "../agents";
import { ModelChoiceError } from "../ai/choice";
import { resolveAgentModel } from "../ai/default-model";
import { consumeActionDecision } from "../../middlewares/rate-limit";
import { needsUserToken } from "../teams/centralino";
import { TemplateRoleSchema } from "../teams/manifest";
import { TeamRuleError, validateRoles } from "../teams/rules";
import { SkillError, createSkill, updateSkill } from "../teams/skills";
import {
  TEMPLATE_MESSAGES,
  TemplateError,
  appendTemplateVersionUnchecked,
  getTemplateRow,
  getTemplateVersion,
  insertTemplateUnchecked,
} from "../teams/templates";
import { subjectHash } from "./subjects/hash";
import {
  CHARACTER_MESSAGES,
  CharacterError,
  MAX_PROPOSALS_PER_TURN,
  RATIONALE_MAX,
  type ProposalKind,
  type SubjectType,
  type TurnContext,
} from "./types";

// Schede create nel turno per ogni contesto creato da `createTurnContext`
const made = new WeakMap<TurnContext, number>();

/** Contesto di un turno con il conteggio delle schede (al massimo 10 per turno). */
export function createTurnContext(base: Omit<TurnContext, "proposalsLeft">): TurnContext {
  const ctx: TurnContext = { ...base, proposalsLeft: () => MAX_PROPOSALS_PER_TURN - (made.get(ctx) ?? 0) };
  made.set(ctx, 0);
  return ctx;
}

/**
 * Salva una scheda `pending` sul messaggio del turno. Oltre 10 schede nel turno (conteggio del contesto e, per
 * sicurezza, delle schede già legate al messaggio) → `{error: «troppe schede in questo turno»}`; motivazione oltre
 * 1 000 caratteri → errore. Il contenuto lo valida chi chiama (lo strumento dell'argomento).
 */
export async function recordProposal(
  ctx: TurnContext,
  kind: ProposalKind,
  payload: unknown,
  rationale: string,
  targetHash: string | null,
): Promise<{ id: number } | { error: string }> {
  if (ctx.proposalsLeft() <= 0) return { error: CHARACTER_MESSAGES.tooManyProposals };
  if (rationale.length > RATIONALE_MAX) return { error: CHARACTER_MESSAGES.rationaleTooLong };
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(characterProposalsTable)
    .where(and(eq(characterProposalsTable.conversationId, ctx.conversationId), eq(characterProposalsTable.messageId, ctx.messageId)));
  if (n >= MAX_PROPOSALS_PER_TURN) return { error: CHARACTER_MESSAGES.tooManyProposals };
  const [row] = await db
    .insert(characterProposalsTable)
    .values({ conversationId: ctx.conversationId, messageId: ctx.messageId, kind, payload: payload ?? {}, rationale, targetHash })
    .returning({ id: characterProposalsTable.id });
  if (made.has(ctx)) made.set(ctx, made.get(ctx)! + 1);
  return { id: row!.id };
}

export type ProposalView = {
  id: number;
  conversationId: number;
  messageId: number;
  kind: ProposalKind;
  payload: unknown;
  rationale: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  decidedAt: Date | null;
  createdAt: Date;
};

export function toProposalView(p: CharacterProposal): ProposalView {
  return {
    id: p.id,
    conversationId: p.conversationId,
    messageId: p.messageId,
    kind: p.kind as ProposalKind,
    payload: p.payload,
    rationale: p.rationale,
    status: p.status,
    decidedAt: p.decidedAt,
    createdAt: p.createdAt,
  };
}

// --- Decisione ---------------------------------------------------------------------------------------

type Executor = Pick<typeof db, "update">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** pending → accepted|rejected con un UPDATE condizionato: chi perde la corsa riceve 409 «scheda già decisa». */
async function markDecided(executor: Executor, id: number, status: "accepted" | "rejected"): Promise<CharacterProposal> {
  const [row] = await executor
    .update(characterProposalsTable)
    .set({ status, decidedAt: new Date() })
    .where(and(eq(characterProposalsTable.id, id), eq(characterProposalsTable.status, "pending")))
    .returning();
  if (!row) throw new CharacterError(409, CHARACTER_MESSAGES.alreadyDecided);
  return row;
}

/**
 * La scheda diventa `stale` (da `from`: `pending`, o `accepted` per la scheda `decision` già prenotata) e si lancia il
 * 409 col messaggio dato; se nel frattempo un'altra richiesta l'ha decisa, 409 «scheda già decisa».
 */
async function markStale(id: number, message: string, from: "pending" | "accepted" = "pending"): Promise<never> {
  const rows = await db
    .update(characterProposalsTable)
    .set({ status: "stale", decidedAt: new Date() })
    .where(and(eq(characterProposalsTable.id, id), eq(characterProposalsTable.status, from)))
    .returning({ id: characterProposalsTable.id });
  throw new CharacterError(409, rows.length > 0 ? message : CHARACTER_MESSAGES.alreadyDecided);
}

/** Toglie la prenotazione di una scheda `decision` (accepted → pending) quando la decisione non è avvenuta. */
async function releaseClaim(id: number): Promise<void> {
  await db
    .update(characterProposalsTable)
    .set({ status: "pending", decidedAt: null })
    .where(and(eq(characterProposalsTable.id, id), eq(characterProposalsTable.status, "accepted")));
}

/** Errori di regola delle funzioni applicate (validazione, nome usato, agente o app inesistenti) con il loro stato. */
function asRuleError(err: unknown): unknown {
  if (err instanceof TeamRuleError || err instanceof SkillError || err instanceof TemplateError || err instanceof AgentError) {
    return new CharacterError(err.status, err.message);
  }
  if (err instanceof ModelChoiceError) return new CharacterError(400, err.message);
  return err;
}

const invalid = (): CharacterError => new CharacterError(400, CHARACTER_MESSAGES.invalidProposal);

function parsePayload<T extends z.ZodTypeAny>(schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

const positiveId = z.number().int().positive();
const PAYLOADS = {
  agent_prompt: z.object({ systemPrompt: z.string() }),
  agent_tools: z.object({ toolIds: z.array(positiveId) }),
  skill_content: z.object({ content: z.string(), toolHints: z.array(z.string()).optional() }),
  template_roles: z.object({ roles: z.array(TemplateRoleSchema) }),
  agent_create: z.object({ appId: positiveId, name: z.string().min(1), systemPrompt: z.string(), toolIds: z.array(positiveId).optional() }),
  skill_create: z.object({ code: z.string(), name: z.string().min(1), description: z.string(), kind: z.enum(["casello", "node"]), content: z.string() }),
  template_create: z.object({ name: z.string().min(1), description: z.string(), roles: z.array(TemplateRoleSchema) }),
  decision: z.object({ number: positiveId, decision: z.enum(["approva", "rifiuta"]), note: z.string().max(500).nullish() }),
} as const;

/** Argomento su cui deve essere nata ogni scheda di Lucius. */
const SUBJECT_OF: Record<Exclude<ProposalKind, "decision" | "handoff">, SubjectType> = {
  agent_prompt: "agent",
  agent_tools: "agent",
  skill_content: "skill",
  template_roles: "team_template",
  agent_create: "area_agents",
  skill_create: "area_skills",
  template_create: "area_team_templates",
};

/** Segnale interno: oggetto sparito o impronta diversa dentro la transazione; si annulla e la scheda diventa `stale`. */
class StaleProposal extends Error {}

type Target = { type: "agent" | "skill" | "team_template"; id: string };

/** Blocca la riga dell'oggetto (FOR UPDATE): false se non c'è più. */
async function lockTarget(tx: Tx, target: Target): Promise<boolean> {
  if (target.type === "skill") {
    const rows = await tx.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.code, target.id)).limit(1).for("update");
    return rows.length > 0;
  }
  const numeric = Number(target.id);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > 2_147_483_647) return false;
  const table = target.type === "agent" ? agentsTable : teamTemplatesTable;
  const rows = await tx.select({ id: table.id }).from(table).where(eq(table.id, numeric)).limit(1).for("update");
  return rows.length > 0;
}

/**
 * Scheda di Lucius: validazioni lette dal pool prima della transazione; poi, nella transazione, scheda `FOR UPDATE`
 * (deve essere `pending`), oggetto `FOR UPDATE`, impronta ricalcolata con `tx`, applicazione con `tx` (le transazioni
 * interne diventano savepoint) e scheda `accepted`. Dentro la transazione non si legge mai dal pool.
 */
async function acceptLucius(userId: number, proposal: CharacterProposal, conv: CharacterConversation): Promise<CharacterProposal> {
  const kind = proposal.kind as keyof typeof SUBJECT_OF;
  if (conv.character !== "lucius" || conv.subjectType !== SUBJECT_OF[kind]) throw invalid();
  const subjectId = conv.subjectId;
  const needsTarget = kind === "agent_prompt" || kind === "agent_tools" || kind === "skill_content" || kind === "template_roles";
  if (needsTarget && subjectId === null) throw invalid();
  const target: Target | null = needsTarget ? { type: SUBJECT_OF[kind] as Target["type"], id: subjectId! } : null;

  const stale = (): Promise<never> => markStale(proposal.id, CHARACTER_MESSAGES.staleObject);

  // Prima verifica dal pool: un oggetto già cambiato non merita le validazioni
  if (target && (await subjectHash(target.type, target.id)) !== proposal.targetHash) await stale();

  let apply: (tx: Tx) => Promise<unknown>;
  try {
    switch (kind) {
      case "agent_prompt": {
        const p = parsePayload(PAYLOADS.agent_prompt, proposal.payload);
        apply = (tx) => updateAgentPrompt(Number(subjectId), p.systemPrompt, tx);
        break;
      }
      case "agent_tools": {
        const p = parsePayload(PAYLOADS.agent_tools, proposal.payload);
        apply = (tx) => setAgentTools(Number(subjectId), p.toolIds, tx);
        break;
      }
      case "skill_content": {
        const p = parsePayload(PAYLOADS.skill_content, proposal.payload);
        apply = (tx) => updateSkill(subjectId!, { content: p.content, ...(p.toolHints !== undefined && { toolHints: p.toolHints }) }, tx);
        break;
      }
      case "template_roles": {
        const p = parsePayload(PAYLOADS.template_roles, proposal.payload);
        const templateId = Number(subjectId);
        // Come `saveTemplate`: modello non archiviato, ruoli validati rispetto alla versione corrente. L'impronta (la
        // versione) ricontrollata nella transazione garantisce che la validazione valga ancora.
        const current = await getTemplateRow(templateId);
        if (current.archived) throw new TemplateError(409, TEMPLATE_MESSAGES.archived);
        const previous = await getTemplateVersion(templateId, current.version);
        await validateRoles({ roles: p.roles, mode: "template", userId, previous });
        apply = async (tx) => {
          const [locked] = await tx.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.id, templateId)).limit(1);
          return appendTemplateVersionUnchecked(templateId, { name: locked!.name, description: locked!.description, roles: p.roles }, tx);
        };
        break;
      }
      case "agent_create": {
        const p = parsePayload(PAYLOADS.agent_create, proposal.payload);
        // Come `POST /api/agents`: modello scelto con `resolveAgentModel` (predefinito dell'utente se è ancora suo)
        const choice = await resolveAgentModel(userId, undefined);
        apply = async (tx) => {
          const agent = await createAreaAgent({ appId: p.appId, name: p.name, systemPrompt: p.systemPrompt, status: "draft" }, choice, tx);
          if (p.toolIds && p.toolIds.length > 0) await setAgentTools(agent.id, p.toolIds, tx);
          return agent;
        };
        break;
      }
      case "skill_create": {
        const p = parsePayload(PAYLOADS.skill_create, proposal.payload);
        apply = (tx) => createSkill(p, tx);
        break;
      }
      case "template_create": {
        const p = parsePayload(PAYLOADS.template_create, proposal.payload);
        await validateRoles({ roles: p.roles, mode: "template", userId, previous: null });
        apply = (tx) => insertTemplateUnchecked(p, tx);
        break;
      }
    }
  } catch (err) {
    // Oggetto sparito tra la prima verifica e le letture di validazione
    if (err instanceof TemplateError && err.status === 404) await stale();
    throw asRuleError(err);
  }

  try {
    return await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(characterProposalsTable).where(eq(characterProposalsTable.id, proposal.id)).limit(1).for("update");
      if (!locked || locked.status !== "pending") throw new CharacterError(409, CHARACTER_MESSAGES.alreadyDecided);
      if (target) {
        if (!(await lockTarget(tx, target))) throw new StaleProposal();
        if ((await subjectHash(target.type, target.id, tx)) !== proposal.targetHash) throw new StaleProposal();
      }
      await apply(tx);
      return markDecided(tx, proposal.id, "accepted");
    });
  } catch (err) {
    if (err instanceof StaleProposal) await stale();
    throw asRuleError(err);
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Scheda `decision` di Alfred. `approveAction`/`rejectAction` hanno le loro transazioni, quindi la scheda si prenota
 * prima con un UPDATE condizionato `pending` → `accepted`: una sola richiesta va avanti, le altre ricevono «scheda già
 * decisa». Poi il limite di 20/min (`consumeActionDecision`) e la decisione. Se la decisione non avviene la
 * prenotazione si toglie (scheda di nuovo `pending`), o la scheda diventa `stale` se la voce è stata decisa altrove.
 */
async function acceptDecision(userId: number, proposal: CharacterProposal, conv: CharacterConversation): Promise<CharacterProposal> {
  if (conv.character !== "alfred" || conv.subjectType !== "alfred_thread") throw invalid();
  const p = parsePayload(PAYLOADS.decision, proposal.payload);

  // La voce dev'essere ancora in attesa con la stessa sintesi (impronta della scheda)
  const [item] = await db
    .select({ action: pendingActionsTable, identity: appToolsTable.identity })
    .from(pendingActionsTable)
    .leftJoin(appToolsTable, eq(appToolsTable.id, pendingActionsTable.toolId))
    .where(and(eq(pendingActionsTable.userId, userId), eq(pendingActionsTable.number, p.number)))
    .limit(1);
  if (!item || item.action.status !== "pending" || sha256(`pending\n${item.action.summary}`) !== proposal.targetHash) {
    await markStale(proposal.id, CHARACTER_MESSAGES.staleItem);
  }
  if (p.decision === "approva" && needsUserToken(item.action.kind, item.identity)) {
    throw new CharacterError(409, CHARACTER_MESSAGES.userTokenItem);
  }

  const claimed = await markDecided(db, proposal.id, "accepted");
  if (!consumeActionDecision(userId)) {
    await releaseClaim(proposal.id);
    throw new CharacterError(429, CHARACTER_MESSAGES.tooMany);
  }
  let out: Awaited<ReturnType<typeof approveAction>>;
  try {
    out = p.decision === "approva" ? await approveAction(userId, p.number) : await rejectAction(userId, p.number, p.note ?? null);
  } catch (err) {
    // Le guardie della coda impediscono comunque una seconda decisione: la scheda si può riprovare
    await releaseClaim(proposal.id);
    throw err;
  }
  if (out.ok) return claimed;
  if (out.status === 404 || (out.status === 409 && out.message === ACTION_MESSAGES.alreadyDecided)) {
    await markStale(proposal.id, CHARACTER_MESSAGES.staleItem, "accepted");
  }
  await releaseClaim(proposal.id);
  throw new CharacterError(out.status, out.message);
}

/**
 * Accetta o rifiuta una scheda dell'utente. Scheda di un'altra conversazione o inesistente → 404 «scheda non trovata»;
 * conversazione archiviata → 409 «conversazione archiviata» (prima di ogni effetto); già decisa → 409; oggetto o voce cambiati → scheda `stale` e 409; errori di regola col loro stato (scheda `pending`);
 * limite delle decisioni sulla coda → 429. Rifiutare non ha effetti; `handoff` accettata non ha effetti sul server.
 */
export async function decideCharacterProposal(userId: number, proposalId: number, decision: "accept" | "reject"): Promise<ProposalView> {
  const [found] = await db
    .select({ proposal: characterProposalsTable, conv: characterConversationsTable })
    .from(characterProposalsTable)
    .innerJoin(characterConversationsTable, eq(characterConversationsTable.id, characterProposalsTable.conversationId))
    .where(and(eq(characterProposalsTable.id, proposalId), eq(characterConversationsTable.userId, userId)))
    .limit(1);
  if (!found) throw new CharacterError(404, CHARACTER_MESSAGES.proposalNotFound);
  const { proposal, conv } = found;
  if (conv.archivedAt !== null) throw new CharacterError(409, CHARACTER_MESSAGES.archived);
  if (proposal.status !== "pending") throw new CharacterError(409, CHARACTER_MESSAGES.alreadyDecided);

  if (decision === "reject") return toProposalView(await markDecided(db, proposalId, "rejected"));
  const kind = proposal.kind as ProposalKind;
  if (kind === "handoff") return toProposalView(await markDecided(db, proposalId, "accepted"));
  if (kind === "decision") return toProposalView(await acceptDecision(userId, proposal, conv));
  return toProposalView(await acceptLucius(userId, proposal, conv));
}
