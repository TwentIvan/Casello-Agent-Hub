// Decisione sulle schede della chat di squadra: accettare applica la proposta alla squadra con le regole di
// `PUT /api/team-instances/:id` (`saveInstance`: validazione fuori dalla transazione, poi riga della squadra
// bloccata). Lo hash del valore attuale si ricontrolla dentro la transazione: due schede nate sullo stesso
// valore non si sovrascrivono, la seconda diventa `stale`.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  teamChatConversationsTable,
  teamChatProposalsTable,
  teamInstanceSkillsTable,
  teamInstancesTable,
  type TeamChatProposal,
} from "@workspace/db";
import { InstanceError, INSTANCE_MESSAGES, saveInstance, type LocalSkillInput } from "../teams/instances";
import { InstanceRoleSchema, MAX_TASK, type InstanceRole } from "../teams/manifest";
import { TeamRuleError } from "../teams/rules";
import { MAX_SKILL_CONTENT } from "../teams/skills";
import { instructionsSkillCode, parseInstructionsFile } from "./instructions-file";

export type TeamChatProposalKind = "role_identity" | "role_instructions";

export const TEAM_CHAT_MESSAGES = {
  proposalNotFound: "scheda non trovata",
  alreadyDecided: "scheda già decisa",
  stale: "la squadra è cambiata: chiedi a Lucius una proposta aggiornata",
  invalidPayload: "scheda non valida",
} as const;

export class TeamChatError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "TeamChatError";
  }
}

export type ProposalView = {
  id: number;
  conversationId: number;
  messageId: number;
  kind: TeamChatProposalKind;
  roleKey: string;
  payload: unknown;
  rationale: string;
  status: "pending" | "accepted" | "rejected" | "stale";
  decidedAt: Date | null;
  createdAt: Date;
};

export function toProposalView(p: TeamChatProposal): ProposalView {
  return {
    id: p.id,
    conversationId: p.conversationId,
    messageId: p.messageId,
    kind: p.kind,
    roleKey: p.roleKey,
    payload: p.payload,
    rationale: p.rationale,
    status: p.status,
    decidedAt: p.decidedAt,
    createdAt: p.createdAt,
  };
}

/** Quanto serve allo hash: va bene un `InstanceView`, uno snapshot della chat o la riga letta nella transazione. */
export type HashSource = {
  roles: ReadonlyArray<{ key: string; task: string }>;
  localSkills: ReadonlyArray<{ code: string; content: string }>;
};

/** SHA-256 (hex) dell'identità del ruolo o del contenuto della skill `ruolo-<key>`; stringa vuota se manca. */
export function currentValueHash(instance: HashSource, kind: TeamChatProposalKind, roleKey: string): string {
  let value: string | undefined;
  if (kind === "role_identity") value = instance.roles.find((r) => r.key === roleKey)?.task;
  else value = instance.localSkills.find((s) => s.code === instructionsSkillCode(roleKey))?.content;
  return value === undefined ? "" : createHash("sha256").update(value).digest("hex");
}

/** Segnale interno: il valore è cambiato, la transazione si annulla e la scheda diventa `stale`. */
class StaleValue extends Error {}

function payloadText(p: TeamChatProposal): string {
  const payload = (p.payload && typeof p.payload === "object" ? p.payload : {}) as Record<string, unknown>;
  const value = p.kind === "role_identity" ? payload.text : payload.markdown;
  if (typeof value !== "string") throw new TeamRuleError(TEAM_CHAT_MESSAGES.invalidPayload);
  return value;
}

/** Ruoli e skill specializzate dopo l'applicazione della scheda (lancia `StaleValue` se il ruolo non c'è più). */
function applyProposal(
  p: TeamChatProposal,
  roles: InstanceRole[],
  localSkills: LocalSkillInput[],
): { roles: InstanceRole[]; localSkills: LocalSkillInput[] } {
  const target = roles.find((r) => r.key === p.roleKey);
  if (!target) throw new StaleValue();
  const value = payloadText(p);
  if (p.kind === "role_identity") {
    if (value.trim() === "" || value.length > MAX_TASK) throw new TeamRuleError(TEAM_CHAT_MESSAGES.invalidPayload);
    return { roles: roles.map((r) => (r.key === p.roleKey ? { ...r, task: value } : r)), localSkills };
  }
  if (value.length > MAX_SKILL_CONTENT) throw new TeamRuleError(TEAM_CHAT_MESSAGES.invalidPayload);
  const parsed = parseInstructionsFile(value, p.roleKey);
  if (!parsed.ok) throw new TeamRuleError(parsed.error);
  const code = instructionsSkillCode(p.roleKey);
  const skill: LocalSkillInput = { code, name: `Istruzioni · ${target.name}`, kind: "casello", content: value, toolHints: [] };
  const exists = localSkills.some((s) => s.code === code);
  return {
    roles: roles.map((r) => (r.key === p.roleKey && !r.localSkills.includes(code) ? { ...r, localSkills: [...r.localSkills, code] } : r)),
    localSkills: exists ? localSkills.map((s) => (s.code === code ? skill : s)) : [...localSkills, skill],
  };
}

async function markStale(proposalId: number): Promise<void> {
  await db
    .update(teamChatProposalsTable)
    .set({ status: "stale", decidedAt: new Date() })
    .where(and(eq(teamChatProposalsTable.id, proposalId), eq(teamChatProposalsTable.status, "pending")));
}

/**
 * Accetta o rifiuta una scheda di Lucius. Squadra chiusa → 409 «squadra chiusa»; scheda già decisa → 409; valore
 * cambiato dopo la proposta → la scheda diventa `stale` e 409. Gli errori di `saveInstance` (es. troppe skill nel
 * ruolo, 400) passano col loro stato e la scheda resta `pending`.
 */
export async function decideTeamChatProposal(userId: number, proposalId: number, decision: "accept" | "reject"): Promise<ProposalView> {
  const [found] = await db
    .select({ proposal: teamChatProposalsTable, instanceId: teamChatConversationsTable.teamInstanceId })
    .from(teamChatProposalsTable)
    .innerJoin(teamChatConversationsTable, eq(teamChatConversationsTable.id, teamChatProposalsTable.conversationId))
    .where(and(eq(teamChatProposalsTable.id, proposalId), eq(teamChatConversationsTable.userId, userId)));
  if (!found) throw new TeamChatError(404, TEAM_CHAT_MESSAGES.proposalNotFound);
  const { proposal, instanceId } = found;
  if (proposal.status !== "pending") throw new TeamChatError(409, TEAM_CHAT_MESSAGES.alreadyDecided);

  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!instance) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
  if (instance.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);

  const markDecided = async (executor: Pick<typeof db, "update">, status: "accepted" | "rejected"): Promise<TeamChatProposal> => {
    const [row] = await executor
      .update(teamChatProposalsTable)
      .set({ status, decidedAt: new Date() })
      .where(and(eq(teamChatProposalsTable.id, proposalId), eq(teamChatProposalsTable.status, "pending")))
      .returning();
    if (!row) throw new TeamChatError(409, TEAM_CHAT_MESSAGES.alreadyDecided);
    return row;
  };

  if (decision === "reject") return toProposalView(await markDecided(db, "rejected"));

  // Letture dal pool, fuori dalla transazione di scrittura (come `saveInstance`)
  const roles = InstanceRoleSchema.array().parse(instance.roles);
  const skillRows = await db.select().from(teamInstanceSkillsTable).where(eq(teamInstanceSkillsTable.instanceId, instanceId));
  const localSkills: LocalSkillInput[] = skillRows.map((s) => ({ code: s.code, name: s.name, kind: s.kind, content: s.content, toolHints: s.toolHints }));
  if (currentValueHash({ roles, localSkills }, proposal.kind, proposal.roleKey) !== proposal.targetHash) {
    await markStale(proposalId);
    throw new TeamChatError(409, TEAM_CHAT_MESSAGES.stale);
  }

  let accepted = null as TeamChatProposal | null;
  try {
    const next = applyProposal(proposal, roles, localSkills);
    await saveInstance(userId, instanceId, { name: instance.name, refTitle: instance.refTitle, roles: next.roles, localSkills: next.localSkills }, db, async (tx, locked) => {
      // Stesso controllo con la squadra bloccata: nel frattempo può essere cambiata
      const lockedRoles = InstanceRoleSchema.array().parse(locked.roles);
      const lockedSkills = await tx.select().from(teamInstanceSkillsTable).where(eq(teamInstanceSkillsTable.instanceId, instanceId));
      if (currentValueHash({ roles: lockedRoles, localSkills: lockedSkills }, proposal.kind, proposal.roleKey) !== proposal.targetHash) {
        throw new StaleValue();
      }
      accepted = await markDecided(tx, "accepted");
    });
  } catch (err) {
    if (!(err instanceof StaleValue)) throw err;
    await markStale(proposalId);
    throw new TeamChatError(409, TEAM_CHAT_MESSAGES.stale);
  }
  return toProposalView(accepted!);
}
