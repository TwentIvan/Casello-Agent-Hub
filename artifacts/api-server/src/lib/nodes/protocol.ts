// Protocollo dei nodi: heartbeat (capacità dichiarate), presa in carico di un compito `waiting_node` con una lease,
// rinnovo della lease e report dell'esito. Un compito va solo a un nodo dello stesso utente che ha attivato la
// squadra e che dichiara tutte le skill `node` del ruolo. Letture e controlli dal pool, fuori dalle transazioni;
// nella transazione del claim: riga della squadra, riga del nodo (conteggio dei compiti in corso), riga del compito
// con SKIP LOCKED. Report e scadenza chiudono il compito con un UPDATE condizionato alla lease: una sola volta.

import { randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  aiModelsTable,
  db,
  nodesTable,
  skillVersionsTable,
  skillsTable,
  teamAttachmentsTable,
  teamInstanceSkillsTable,
  teamInstancesTable,
  teamTasksTable,
  type Node,
  type TeamInstanceRow,
  type TeamTaskRow,
} from "@workspace/db";
import { NodeGitAccessError, nodeGitContext, adoptNodePull, gitContext } from "../code-writer/node-git";
import { GithubError, installationTokenWithExpiry } from "../github/app";
import { userHasInstallation } from "../github/installations";
import { logger } from "../logger";
import { nodeSupportsGit } from "./git-version";
import { compareVersions, isBelowMinVersion, loadNodeManifest, updateFor, type NodeUpdate } from "./manifest";
import { ATTACHMENT_MESSAGES, taskAttachmentViews, validateNodeWorkspace } from "../teams/attachments";
import { InstanceRoleSchema, type InstanceRole } from "../teams/manifest";
import { getPlan, patchPlan } from "../teams/plan";
import { errName, finishTaskExecution, skillTexts, MAX_TASK_DETAIL, MAX_TASK_OUTCOME } from "../teams/task-runner";
import { TEAM_BUDGET_REACHED, teamCapBlock } from "../teams/team-budget";

/** Durata della lease di un compito preso da un nodo. */
export const LEASE_MS = 15 * 60_000;
/** Compiti esaminati al massimo per heartbeat o claim. */
const MAX_CANDIDATES = 200;

export const NODE_PROTOCOL_MESSAGES = {
  lease: "lease non valida o scaduta",
  disabled: "nodo disattivato",
} as const;

/** Errore del protocollo con lo stato HTTP (409 lease, 403 nodo non attivo). */
export class NodeError extends Error {
  constructor(
    public readonly status: 403 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = "NodeError";
  }
}

export interface NodeCapabilities {
  version: string;
  executor: string;
  skills: string[];
  workspaceRoot: string;
  maxConcurrent: number;
  /** Sottocartelle della radice (percorsi relativi); assente = elenco salvato invariato (nodo di versione precedente). */
  folders?: string[];
  /** Come è installato il nodo; assente = invariato (nodo di versione precedente). */
  kind?: "app" | "cli";
  /** Stato di Claude Code sul Mac (assente = invariato). */
  claude?: Record<string, unknown>;
  /** Git sul Mac, campi non verificati (assente = invariato). */
  git?: Record<string, unknown>;
  /** Versione di cui l'aggiornamento non è riuscito. */
  updateFailed?: string;
}

export interface HeartbeatResult {
  pending: number;
  update?: NodeUpdate;
  settings?: { maxConcurrent: number | null; maxConcurrentTurns: number | null; taskTimeoutMinutes: number | null };
  diagnosticsRequested?: boolean;
  uninstallRequested?: boolean;
}

const CLAUDE_STRING_KEYS = ["version", "authMethod", "subscriptionType", "loginExpiresAt"] as const;

/** Solo i campi noti dello stato di Claude, ognuno col suo tipo e al più 100 caratteri: mai email né id dell'organizzazione. */
export function cleanClaudeStatus(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { found: input["found"] === true };
  if (typeof input["loggedIn"] === "boolean") out["loggedIn"] = input["loggedIn"];
  for (const key of CLAUDE_STRING_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) out[key] = value.slice(0, 100);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = String(value).slice(0, 100);
  }
  return out;
}

/** Solo `found` (booleano) e `version` (stringa ≤ 50 caratteri o null); input non oggetto → null (nulla da salvare). */
export function cleanGitStatus(input: unknown): { found: boolean; version: string | null } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const version = rec["version"];
  return {
    found: rec["found"] === true,
    version: typeof version === "string" && version.length > 0 ? version.slice(0, 50) : null,
  };
}

export interface NodeReport {
  leaseToken: string;
  status: "done" | "blocked" | "failed";
  outcome: string;
  detail?: string;
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  sessionId?: string;
  /** Stato Git del compito sul Mac: serve solo a decidere se aprire la PR. */
  git?: { pushed: boolean; headSha: string | null; commits: number };
}

export interface TaskPackage {
  taskId: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  team: { id: number; name: string; refType: string; refId: string; refTitle: string };
  workspace: string | null;
  role: { key: string; name: string; task: string; preferredModel: string | null };
  task: { planTaskId: string; title: string; instructions: string };
  plan: {
    objective: string;
    constraints: string[];
    openPoints: string[];
    tasks: { id: string; title: string; roleKey: string; status: string; outcome: string | null }[];
    manualActions: { id: string; text: string; done: boolean }[];
  };
  caselloSkills: { code: string; version: number | null; content: string }[];
  nodeSkills: string[];
  /** Allegati citati dal compito (solo metadati: il nodo scarica i byte con `taskAttachment`). */
  attachments: { id: number; name: string; contentType: string; sizeBytes: number; sha256: string }[];
  /** Repository, base e branch dei compiti con codice in scrittura (null negli altri). */
  git: { repo: string; baseBranch: string; branch: string; issue: number | null } | null;
}

// ─── Skill dei ruoli ────────────────────────────────────────────────────────

function roleOf(instance: TeamInstanceRow, key: string): InstanceRole | undefined {
  return InstanceRoleSchema.array().parse(instance.roles).find((r) => r.key === key);
}

/**
 * Nomi delle skill sul nodo richiesti dal ruolo: skill `node` del catalogo (contenuto della versione fissata) e
 * skill specializzate di tipo `node` dell'istanza (contenuto), senza ripetizioni.
 */
export async function roleNodeSkills(instanceId: number, role: InstanceRole): Promise<string[]> {
  const names: string[] = [];
  if (role.skills.length > 0) {
    const rows = await db
      .select({ code: skillsTable.code, kind: skillsTable.kind, version: skillVersionsTable.version, content: skillVersionsTable.content })
      .from(skillVersionsTable)
      .innerJoin(skillsTable, eq(skillVersionsTable.skillId, skillsTable.id))
      .where(inArray(skillsTable.code, role.skills.map((s) => s.code)));
    for (const pinned of role.skills) {
      const row = rows.find((r) => r.code === pinned.code && r.version === pinned.version);
      if (row?.kind === "node") names.push(row.content);
    }
  }
  if (role.localSkills.length > 0) {
    const rows = await db
      .select()
      .from(teamInstanceSkillsTable)
      .where(and(eq(teamInstanceSkillsTable.instanceId, instanceId), inArray(teamInstanceSkillsTable.code, role.localSkills)));
    for (const code of role.localSkills) {
      const row = rows.find((r) => r.code === code);
      if (row?.kind === "node") names.push(row.content);
    }
  }
  return [...new Set(names)];
}

/** Il nodo dichiara tutte le skill richieste. */
export const hasSkills = (declared: string[], required: string[]): boolean => required.every((s) => declared.includes(s));

// ─── Compiti che un nodo può prendere ───────────────────────────────────────

interface Candidate {
  task: TeamTaskRow;
  instance: TeamInstanceRow;
  role: InstanceRole;
  nodeSkills: string[];
}

/**
 * Compiti `waiting_node` delle squadre attive attivate dall'utente del nodo, dal più vecchio, con le skill del ruolo
 * tutte dichiarate dal nodo: `eligible` quelli delle squadre entro il tetto di spesa, `capped` quelli delle squadre
 * oltre il tetto (il claim li chiude `blocked`, l'heartbeat non li conta).
 */
async function eligibleTasks(node: Node): Promise<{ eligible: Candidate[]; capped: Candidate[] }> {
  const rows = await db
    .select({ task: teamTasksTable, instance: teamInstancesTable })
    .from(teamTasksTable)
    .innerJoin(teamInstancesTable, eq(teamTasksTable.instanceId, teamInstancesTable.id))
    .where(and(eq(teamTasksTable.status, "waiting_node"), eq(teamInstancesTable.status, "active"), eq(teamInstancesTable.activatedBy, node.userId)))
    .orderBy(asc(sql`coalesce(${teamTasksTable.waitingSince}, ${teamTasksTable.createdAt})`), asc(teamTasksTable.id))
    .limit(MAX_CANDIDATES);

  const capped = new Map<number, boolean>();
  const skillsByRole = new Map<string, string[]>();
  const eligible: Candidate[] = [];
  const cappedTasks: Candidate[] = [];
  for (const { task, instance } of rows) {
    const role = roleOf(instance, task.roleKey);
    if (!role || role.runsOn !== "node") continue;
    const roleId = `${instance.id}:${role.key}`;
    let nodeSkills = skillsByRole.get(roleId);
    if (!nodeSkills) {
      nodeSkills = await roleNodeSkills(instance.id, role);
      skillsByRole.set(roleId, nodeSkills);
    }
    if (!hasSkills(node.skills, nodeSkills)) continue;
    // Il flusso Git automatico richiede un nodo aggiornato: i vecchi continuano con i compiti senza codice
    if (role.code === "write" && !nodeSupportsGit(node.version)) continue;
    if (!capped.has(instance.id)) capped.set(instance.id, (await teamCapBlock(instance.id)) !== null);
    (capped.get(instance.id) ? cappedTasks : eligible).push({ task, instance, role, nodeSkills });
  }
  return { eligible, capped: cappedTasks };
}

async function activeNode(nodeId: number): Promise<Node> {
  const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);
  if (!node || node.status !== "active") throw new NodeError(403, NODE_PROTOCOL_MESSAGES.disabled);
  return node;
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

/** Aggiorna le capacità dichiarate e `last_seen_at`; `pending` = compiti che il nodo potrebbe prendere. */
/**
 * Cartelle dichiarate dal nodo: solo quelle valide come spazio di lavoro (le altre non si potrebbero scegliere),
 * senza ripetizioni, in ordine alfabetico.
 */
export function cleanFolders(folders: string[]): string[] {
  return [...new Set(folders.filter((f) => validateNodeWorkspace(f) === null))].sort((a, b) => a.localeCompare(b));
}

export async function heartbeat(nodeId: number, caps: NodeCapabilities): Promise<HeartbeatResult> {
  const now = new Date();
  const gitStatus = caps.git === undefined ? null : cleanGitStatus(caps.git);
  const [updated] = await db
    .update(nodesTable)
    .set({
      version: caps.version,
      executor: caps.executor,
      skills: [...new Set(caps.skills)],
      workspaceRoot: caps.workspaceRoot,
      maxConcurrent: caps.maxConcurrent,
      ...(caps.folders ? { workspaceFolders: cleanFolders(caps.folders), foldersUpdatedAt: now } : {}),
      ...(caps.kind ? { kind: caps.kind } : {}),
      ...(caps.claude ? { claudeStatus: cleanClaudeStatus(caps.claude), claudeCheckedAt: now } : {}),
      ...(gitStatus ? { gitStatus } : {}),
      ...(caps.updateFailed ? { updateFailedVersion: caps.updateFailed.slice(0, 100) } : {}),
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(and(eq(nodesTable.id, nodeId), eq(nodesTable.status, "active")))
    .returning();
  if (!updated) throw new NodeError(403, NODE_PROTOCOL_MESSAGES.disabled);
  let node = updated;
  // Il nodo gira ormai con la versione fallita o una più nuova (aggiornato in altro modo): l'avviso non vale più
  const failed = node.updateFailedVersion;
  if (failed !== null && (compareVersions(caps.version, failed) ?? -1) >= 0) {
    const [cleared] = await db
      .update(nodesTable)
      .set({ updateFailedVersion: null })
      .where(and(eq(nodesTable.id, nodeId), eq(nodesTable.updateFailedVersion, failed)))
      .returning();
    if (cleared) node = cleared;
  }
  const result: HeartbeatResult = { pending: (await eligibleTasks(node)).eligible.length };
  const update = updateFor(node.version, node.kind, loadNodeManifest(), node.updateFailedVersion);
  if (update) result.update = update;
  if (node.settings) {
    const pick = (key: string): number | null => (typeof node.settings![key] === "number" ? (node.settings![key] as number) : null);
    result.settings = { maxConcurrent: pick("maxConcurrent"), maxConcurrentTurns: pick("maxConcurrentTurns"), taskTimeoutMinutes: pick("taskTimeoutMinutes") };
  }
  if (node.diagnosticsRequestedAt) result.diagnosticsRequested = true;
  if (node.uninstallRequestedAt) result.uninstallRequested = true;
  return result;
}

// ─── Claim ──────────────────────────────────────────────────────────────────

type ClaimAttempt = { kind: "claimed"; task: TeamTaskRow } | { kind: "skip" } | { kind: "full" };

/**
 * Prova a prendere un compito: riga della squadra bloccata (ancora attiva e dell'utente), poi riga del nodo bloccata
 * (due claim dello stesso nodo non superano `max_concurrent`), poi il compito con SKIP LOCKED ancora `waiting_node`.
 */
async function tryClaim(node: Node, candidate: Candidate): Promise<ClaimAttempt> {
  return db.transaction(async (tx): Promise<ClaimAttempt> => {
    const [instance] = await tx
      .select({ status: teamInstancesTable.status, activatedBy: teamInstancesTable.activatedBy })
      .from(teamInstancesTable)
      .where(eq(teamInstancesTable.id, candidate.instance.id))
      .for("update")
      .limit(1);
    if (instance?.status !== "active" || instance.activatedBy !== node.userId) return { kind: "skip" };
    const [lockedNode] = await tx
      .select({ status: nodesTable.status, maxConcurrent: nodesTable.maxConcurrent })
      .from(nodesTable)
      .where(eq(nodesTable.id, node.id))
      .for("update")
      .limit(1);
    if (lockedNode?.status !== "active") return { kind: "full" };
    const [running] = await tx
      .select({ n: count() })
      .from(teamTasksTable)
      .where(and(eq(teamTasksTable.nodeId, node.id), eq(teamTasksTable.status, "running"), isNotNull(teamTasksTable.leaseToken)));
    if (Number(running?.n ?? 0) >= lockedNode.maxConcurrent) return { kind: "full" };
    const [free] = await tx
      .select({ id: teamTasksTable.id })
      .from(teamTasksTable)
      .where(and(eq(teamTasksTable.id, candidate.task.id), eq(teamTasksTable.status, "waiting_node")))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!free) return { kind: "skip" };
    const now = new Date();
    const [task] = await tx
      .update(teamTasksTable)
      .set({
        status: "running",
        nodeId: node.id,
        leaseToken: randomBytes(32).toString("base64url"),
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        startedAt: now,
      })
      .where(and(eq(teamTasksTable.id, free.id), eq(teamTasksTable.status, "waiting_node")))
      .returning();
    return task ? { kind: "claimed", task } : { kind: "skip" };
  });
}

async function preferredModel(role: InstanceRole): Promise<string | null> {
  if (role.aiModelId === null) return null;
  const [row] = await db.select({ name: aiModelsTable.displayName, modelId: aiModelsTable.modelId }).from(aiModelsTable).where(eq(aiModelsTable.id, role.aiModelId));
  return row ? row.name || row.modelId : null;
}

async function buildPackage(candidate: Candidate, task: TeamTaskRow): Promise<TaskPackage> {
  const { instance, role } = candidate;
  const [plan, skills, model, attachments] = await Promise.all([
    getPlan(instance.id),
    skillTexts(instance.id, role),
    preferredModel(role),
    taskAttachmentViews(instance.id, task.attachmentIds),
  ]);
  const planTask = plan.tasks.find((t) => t.id === task.planTaskId);
  const gitCtx = role.code === "write" ? await nodeGitContext(instance, task, planTask?.issue ?? null) : null;
  return {
    taskId: task.id,
    leaseToken: task.leaseToken!,
    leaseExpiresAt: task.leaseExpiresAt!,
    team: { id: instance.id, name: instance.name, refType: instance.refType, refId: instance.refId, refTitle: instance.refTitle },
    workspace: instance.nodeWorkspace,
    role: { key: role.key, name: role.name, task: role.task, preferredModel: model },
    task: {
      planTaskId: task.planTaskId,
      title: planTask?.title ?? task.planTaskId,
      instructions: gitCtx?.instructions ?? task.instructions,
    },
    plan: {
      objective: plan.objective,
      constraints: plan.constraints,
      openPoints: plan.openPoints,
      tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, roleKey: t.roleKey, status: t.status, outcome: t.outcome })),
      manualActions: plan.manualActions.map((a) => ({ id: a.id, text: a.text, done: a.done })),
    },
    caselloSkills: skills.map((s) => ({ code: s.code, version: s.version, content: s.content })),
    nodeSkills: candidate.nodeSkills,
    attachments: attachments.map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, sizeBytes: a.sizeBytes, sha256: a.sha256 })),
    git: gitCtx?.git ?? null,
  };
}

/** Rimette in attesa un compito appena preso (solo se la lease è ancora quella del claim). */
async function releaseClaim(task: TeamTaskRow): Promise<void> {
  await db
    .update(teamTasksTable)
    .set({ status: "waiting_node", nodeId: null, leaseToken: null, leaseExpiresAt: null, startedAt: null })
    .where(and(eq(teamTasksTable.id, task.id), eq(teamTasksTable.status, "running"), eq(teamTasksTable.leaseToken, task.leaseToken!)));
  await patchPlan(task.instanceId, { tasks: [{ id: task.planTaskId, status: "waiting_node", outcome: null }] });
}

/**
 * Squadra oltre il tetto: il compito in attesa si chiude `blocked` come un compito cloud bloccato dal tetto (PLAN,
 * evento `bloccato`, turno del capo), con un UPDATE condizionato a `waiting_node`: una volta sola.
 */
export async function blockCappedTask(task: TeamTaskRow): Promise<boolean> {
  try {
    return await finishTaskExecution(
      task,
      { status: "blocked", outcome: TEAM_BUDGET_REACHED, error: TEAM_BUDGET_REACHED },
      { promptTokens: null, completionTokens: null, costUsd: null },
      { kind: "waiting" },
    );
  } catch (err) {
    logger.error({ teamTaskId: task.id, errName: errName(err) }, "Blocco per tetto del compito del nodo non riuscito");
    return false;
  }
}

/**
 * Compito appena preso con il repository non accessibile in modo duraturo: si chiude `blocked` «accesso al repository
 * non disponibile» (PLAN, evento, turno del capo) e la lease si toglie, così non torna in testa alla coda a ogni claim.
 */
async function blockGitAccessTask(task: TeamTaskRow): Promise<void> {
  try {
    await finishTaskExecution(
      task,
      { status: "blocked", outcome: GIT_ACCESS_MESSAGE, error: GIT_ACCESS_MESSAGE },
      { promptTokens: null, completionTokens: null, costUsd: null },
      { kind: "node", nodeId: task.nodeId!, leaseToken: task.leaseToken! },
    );
  } catch (err) {
    logger.error({ teamTaskId: task.id, errName: errName(err) }, "Blocco del compito del nodo senza accesso al repository non riuscito");
  }
}

/**
 * Prende il compito più vecchio che il nodo può eseguire e ne restituisce il pacchetto; null se non c'è nulla. Se il
 * pacchetto non si prepara il compito si chiude `blocked` (repository non accessibile) o torna in attesa (errore
 * temporaneo), e il claim passa al candidato successivo: un compito difettoso non ferma gli altri.
 */
export async function claimTask(nodeId: number): Promise<TaskPackage | null> {
  const node = await activeNode(nodeId);
  // Versione sotto la minima del protocollo: niente lavoro finché il nodo non si aggiorna
  if (isBelowMinVersion(node.version, loadNodeManifest())) return null;
  const { eligible, capped } = await eligibleTasks(node);
  for (const candidate of capped) await blockCappedTask(candidate.task);
  for (const candidate of eligible) {
    const attempt = await tryClaim(node, candidate);
    if (attempt.kind === "full") return null;
    if (attempt.kind === "skip") continue;
    const task = attempt.task;
    try {
      // Dopo il commit: la transazione non blocca la riga del PLAN
      await patchPlan(task.instanceId, { tasks: [{ id: task.planTaskId, status: "running", outcome: null }] });
      return await buildPackage(candidate, task);
    } catch (err) {
      if (err instanceof NodeGitAccessError) {
        logger.warn({ teamTaskId: task.id }, "Repository del compito del nodo non accessibile: compito bloccato");
        await blockGitAccessTask(task);
        continue;
      }
      logger.error({ teamTaskId: task.id, errName: errName(err) }, "Preparazione del pacchetto del nodo non riuscita: compito rimesso in attesa");
      try {
        await releaseClaim(task);
      } catch (releaseErr) {
        logger.error({ teamTaskId: task.id, errName: errName(releaseErr) }, "Compito del nodo non rimesso in attesa: lo chiuderà la scadenza della lease");
      }
    }
  }
  return null;
}

// ─── Ping e report ──────────────────────────────────────────────────────────

/** Rinnova di LEASE_MS la lease del compito del nodo; lease non valida o scaduta → 409. */
export async function pingTask(nodeId: number, taskId: number, leaseToken: string): Promise<{ leaseExpiresAt: Date }> {
  const now = new Date();
  const [row] = await db
    .update(teamTasksTable)
    .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(teamTasksTable.id, taskId),
        eq(teamTasksTable.nodeId, nodeId),
        eq(teamTasksTable.status, "running"),
        eq(teamTasksTable.leaseToken, leaseToken),
        gt(teamTasksTable.leaseExpiresAt, now),
      ),
    )
    .returning({ leaseExpiresAt: teamTasksTable.leaseExpiresAt });
  if (!row?.leaseExpiresAt) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  return { leaseExpiresAt: row.leaseExpiresAt };
}

const GIT_ACCESS_MESSAGE = "accesso al repository non disponibile";

/**
 * Token d'installazione ristretto al repository dell'App di riferimento (`contents: write`) per il nodo che ha in
 * lease un compito `running` di un ruolo `code = write`: serve a fetch e push da `casello-nodo`. Lease non valida →
 * 409; ruolo senza codice, App senza repository o installazione, GitHub non configurato o installazione non di chi ha
 * attivato la squadra → 409 «accesso al repository non disponibile»; errore di GitHub → 502 col suo messaggio fisso.
 * Il token non si registra mai nei log.
 */
export async function gitTokenForTask(nodeId: number, taskId: number, leaseToken: string): Promise<{ token: string; expiresAt: Date }> {
  const now = new Date();
  const [task] = await db
    .select()
    .from(teamTasksTable)
    .where(
      and(
        eq(teamTasksTable.id, taskId),
        eq(teamTasksTable.nodeId, nodeId),
        eq(teamTasksTable.status, "running"),
        eq(teamTasksTable.leaseToken, leaseToken),
        gt(teamTasksTable.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  if (!task) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, task.instanceId)).limit(1);
  const role = instance ? InstanceRoleSchema.array().parse(instance.roles).find((r) => r.key === task.roleKey) : undefined;
  if (!instance || !role || role.code !== "write" || instance.activatedBy === null) throw new NodeError(409, GIT_ACCESS_MESSAGE);
  const ctx = await gitContext(instance);
  if (!ctx?.ref || !(await userHasInstallation(instance.activatedBy, ctx.ref.installationId))) throw new NodeError(409, GIT_ACCESS_MESSAGE);
  try {
    const { token, expiresAt } = await installationTokenWithExpiry(ctx.ref.cfg, ctx.ref.installationId, {
      repo: ctx.ref.repo,
      permissions: { contents: "write" },
    });
    return { token, expiresAt: new Date(expiresAt) };
  } catch (err) {
    if (err instanceof GithubError) throw new NodeError(502, err.message);
    throw err;
  }
}

/**
 * Contenuto di un allegato citato dal compito, per il nodo che lo ha in lease (compito `running`, nodo e lease del
 * claim, lease non scaduta). Un allegato eliminato dopo l'assegnazione si scarica comunque; uno non citato dal
 * compito o di un'altra squadra → 404; lease non valida o scaduta → 409.
 */
export async function taskAttachment(nodeId: number, taskId: number, leaseToken: string, attachmentId: number) {
  const now = new Date();
  const [task] = await db
    .select({ instanceId: teamTasksTable.instanceId, attachmentIds: teamTasksTable.attachmentIds })
    .from(teamTasksTable)
    .where(
      and(
        eq(teamTasksTable.id, taskId),
        eq(teamTasksTable.nodeId, nodeId),
        eq(teamTasksTable.status, "running"),
        eq(teamTasksTable.leaseToken, leaseToken),
        gt(teamTasksTable.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  if (!task) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  if (!task.attachmentIds.includes(attachmentId)) throw new NodeError(404, ATTACHMENT_MESSAGES.notFound);
  const [row] = await db
    .select()
    .from(teamAttachmentsTable)
    .where(and(eq(teamAttachmentsTable.id, attachmentId), eq(teamAttachmentsTable.instanceId, task.instanceId)))
    .limit(1);
  if (!row) throw new NodeError(404, ATTACHMENT_MESSAGES.notFound);
  return row;
}

/**
 * Chiude il compito con l'esito del nodo, come i compiti cloud (PLAN, evento, turno del capo). Il costo riferito si
 * registra con `ai_model_id` null: conta solo nel tetto della squadra. Lease non valida o scaduta → 409, nulla salvato.
 */
export async function reportTask(nodeId: number, taskId: number, input: NodeReport): Promise<void> {
  const [task] = await db.select().from(teamTasksTable).where(eq(teamTasksTable.id, taskId)).limit(1);
  if (!task || task.nodeId !== nodeId || task.leaseToken !== input.leaseToken) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  const outcome = input.outcome.slice(0, MAX_TASK_OUTCOME);
  const closed = await finishTaskExecution(
    task,
    {
      status: input.status,
      outcome,
      detail: input.detail === undefined ? null : input.detail.slice(0, MAX_TASK_DETAIL),
      error: input.status === "failed" ? outcome : null,
    },
    { promptTokens: input.promptTokens ?? null, completionTokens: input.completionTokens ?? null, costUsd: input.costUsd ?? null },
    { kind: "lease", nodeId, leaseToken: input.leaseToken, now: new Date(), sessionId: input.sessionId ?? null },
  );
  if (!closed) throw new NodeError(409, NODE_PROTOCOL_MESSAGES.lease);
  // Ruolo con codice: la PR aperta sul branch del compito passa alla sorveglianza (non solleva mai)
  if (input.status === "done") await adoptNodePull(task, { git: input.git, outcome });
}
