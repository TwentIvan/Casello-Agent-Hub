import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  agentSkillsTable,
  agentToolsTable,
  agentsTable,
  appToolsTable,
  type AnalysisItem,
} from "@workspace/db";
import { findUsableSystemModelId } from "../ai/system-account";
import { DEFAULT_MODEL } from "../models";
import { isUniqueViolation } from "../pg-errors";
import { checkParamsSchema, checkPathPlaceholders, parseDefinition } from "../tools/definition";
import type { HttpDefinition } from "../tools/types";
import {
  ITEM_SCHEMAS,
  type AgentProposal,
  type SkillProposal,
  type ToolProposal,
} from "./schemas";

/** Proposta non applicabile (messaggio in italiano, la route risponde 400): nulla è stato scritto. */
export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyError";
  }
}

/** Transazione di drizzle: si può passare a `applyItem` per eseguirlo dentro una transazione del chiamante. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Rivalida il payload (può essere stato modificato dall'utente): primo errore di Zod in italiano. */
function parsePayload<T>(item: AnalysisItem): T {
  const parsed = ITEM_SCHEMAS[item.chapter].safeParse(item.payload);
  if (parsed.success) return parsed.data as T;
  const issue = parsed.error.issues[0]!;
  const path = issue.path.join(".");
  throw new ApplyError(path ? `${path}: ${issue.message}` : issue.message);
}

/** Coerenza ruolo/area: `general` senza area, `area` con un'area non vuota. */
function checkRoleArea(role: "general" | "area", area: string | null, what: string): void {
  if (role === "general" && area !== null) {
    throw new ApplyError(`${what}: l'agente generale non ha un'area`);
  }
  if (role === "area" && (area === null || area.trim() === "")) {
    throw new ApplyError(`${what}: un agente di area richiede il nome dell'area`);
  }
}

// --- Tool ---

// Spec §6: approvare un tool o un agente li crea/aggiorna nello stato `active` (anche se invariati).

async function applyTool(tx: Tx, item: AnalysisItem, appId: number): Promise<void> {
  if (item.diff === "unchanged") {
    // Invariato: la definizione resta com'è, il tool diventa attivo (es. una bozza creata a mano)
    const tool = parsePayload<ToolProposal>(item);
    const [row] = await tx
      .update(appToolsTable)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(appToolsTable.appId, appId), eq(appToolsTable.name, tool.name)))
      .returning({ id: appToolsTable.id });
    if (!row) throw new ApplyError(`Lo strumento "${tool.name}" non esiste nell'app`);
    return;
  }

  if (item.diff === "removed") {
    // Il payload è il tool esistente: serve solo il nome. Non si cancella mai, si disattiva.
    const name = (item.payload as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name) throw new ApplyError("name: campo obbligatorio");
    const [row] = await tx
      .update(appToolsTable)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(and(eq(appToolsTable.appId, appId), eq(appToolsTable.name, name)))
      .returning({ id: appToolsTable.id });
    if (!row) throw new ApplyError(`Lo strumento "${name}" non esiste nell'app`);
    return;
  }

  const tool = parsePayload<ToolProposal>(item);
  // Stesse validazioni del salvataggio di un tool (fase 1), anche se lo schema le ripete
  const parsed = parseDefinition("http", tool.definition);
  if (!parsed.ok) throw new ApplyError(parsed.error);
  const schemaError = checkParamsSchema(tool.paramsSchema);
  if (schemaError) throw new ApplyError(schemaError);
  const placeholderError = checkPathPlaceholders(parsed.value as HttpDefinition, tool.paramsSchema);
  if (placeholderError) throw new ApplyError(placeholderError);

  const [current] = await tx
    .select()
    .from(appToolsTable)
    .where(and(eq(appToolsTable.appId, appId), eq(appToolsTable.name, tool.name)))
    .limit(1);

  const fields = {
    description: tool.description,
    kind: tool.kind,
    identity: tool.identity,
    requiresConfirmation: tool.requiresConfirmation,
    readOnly: tool.readOnly,
    paramsSchema: tool.paramsSchema,
    definition: tool.definition,
    evidence: tool.evidence,
    needsVerification: tool.needsVerification,
  };

  if (item.diff === "new") {
    if (current) throw new ApplyError(`Esiste già uno strumento "${tool.name}" nell'app`);
    try {
      await tx.insert(appToolsTable).values({ ...fields, appId, name: tool.name, status: "active" });
    } catch (err) {
      if (!isUniqueViolation(err, "app_tools_app_id_name_unique")) throw err;
      throw new ApplyError(`Esiste già uno strumento "${tool.name}" nell'app`);
    }
    return;
  }

  // changed: aggiornato e attivo (anche se era in bozza o disattivato)
  if (!current) throw new ApplyError(`Lo strumento "${tool.name}" non esiste nell'app`);
  await tx
    .update(appToolsTable)
    .set({ ...fields, status: "active", updatedAt: new Date() })
    .where(eq(appToolsTable.id, current.id));
}

// --- Agenti e skill ---

/** Tool dell'app per nome; con `activeOnly` ognuno deve anche essere `active`. Nome mancante → ApplyError. */
async function resolveTools(
  tx: Tx,
  appId: number,
  names: string[],
  activeOnly: boolean,
): Promise<Map<string, number>> {
  const unique = [...new Set(names)];
  const ids = new Map<string, number>();
  if (!unique.length) return ids;
  const rows = await tx
    .select({ id: appToolsTable.id, name: appToolsTable.name, status: appToolsTable.status })
    .from(appToolsTable)
    .where(and(eq(appToolsTable.appId, appId), inArray(appToolsTable.name, unique)));
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const name of unique) {
    const row = byName.get(name);
    if (!row) throw new ApplyError(`Lo strumento "${name}" non esiste nell'app`);
    if (activeOnly && row.status !== "active") {
      throw new ApplyError(`Lo strumento "${name}" non è attivo: approva prima il tool`);
    }
    ids.set(name, row.id);
  }
  return ids;
}

const trimArea = (area: string | null): string | null => (area === null ? null : area.trim());

/** Agente dell'app individuato da (ruolo, area); per `general` l'area è ignorata. */
async function findAgent(tx: Tx, appId: number, role: "general" | "area", area: string | null) {
  const rows = await tx
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.appId, appId), eq(agentsTable.role, role)))
    .orderBy(agentsTable.id);
  return role === "general" ? rows[0] : rows.find((a) => trimArea(a.area) === area);
}

async function applyAgent(tx: Tx, item: AnalysisItem, appId: number): Promise<void> {
  if (item.diff === "removed") return;
  const parsedAgent = parsePayload<AgentProposal>(item);
  const agent = { ...parsedAgent, area: trimArea(parsedAgent.area) };
  checkRoleArea(agent.role, agent.area, "agente");

  const current = await findAgent(tx, appId, agent.role, agent.area);

  if (item.diff === "unchanged") {
    // Invariato: nessuna modifica ai contenuti, l'agente diventa attivo
    if (!current) throw new ApplyError("L'agente non esiste nell'app");
    // Un agente di area attivo usa solo tool attivi, come quando è nuovo o modificato
    if (agent.role === "area") await resolveTools(tx, appId, agent.toolNames, true);
    await tx.update(agentsTable).set({ status: "active", updatedAt: new Date() }).where(eq(agentsTable.id, current.id));
    return;
  }

  if (agent.role === "general") {
    // L'agente generale esiste già (creato con l'app) e usa tutti i tool attivi: nessun collegamento
    if (!current) throw new ApplyError("L'app non ha un agente generale");
    await tx
      .update(agentsTable)
      .set({
        systemPrompt: agent.systemPrompt,
        defaultIdentity: agent.defaultIdentity,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(agentsTable.id, current.id));
    return;
  }

  const toolIds = await resolveTools(tx, appId, agent.toolNames, true);
  let agentId: number;
  if (current) {
    agentId = current.id;
    await tx
      .update(agentsTable)
      .set({
        name: agent.name,
        area: agent.area,
        systemPrompt: agent.systemPrompt,
        defaultIdentity: agent.defaultIdentity,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(agentsTable.id, current.id));
  } else {
    // Nuovo agente di area: attivo, modello predefinito collegato all'account di sistema (null se non c'è)
    const aiModelId = await findUsableSystemModelId(DEFAULT_MODEL, tx);
    const [created] = await tx
      .insert(agentsTable)
      .values({
        appId,
        aiModelId,
        role: "area",
        area: agent.area,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        defaultIdentity: agent.defaultIdentity,
        status: "active",
      })
      .returning({ id: agentsTable.id });
    agentId = created!.id;
  }

  // I collegamenti diventano esattamente quelli nominati
  await tx.delete(agentToolsTable).where(eq(agentToolsTable.agentId, agentId));
  if (toolIds.size) {
    await tx.insert(agentToolsTable).values([...toolIds.values()].map((toolId) => ({ agentId, toolId })));
  }
}

async function applySkill(tx: Tx, item: AnalysisItem, appId: number): Promise<void> {
  if (item.diff === "unchanged" || item.diff === "removed") return;
  const parsedSkill = parsePayload<SkillProposal>(item);
  const skill = { ...parsedSkill, agentArea: trimArea(parsedSkill.agentArea) };
  checkRoleArea(skill.agentRole, skill.agentArea, "skill");

  const agent = await findAgent(tx, appId, skill.agentRole, skill.agentArea);
  if (!agent) {
    const who = skill.agentRole === "general" ? "generale" : `di area "${skill.agentArea}"`;
    throw new ApplyError(`L'agente ${who} della skill "${skill.name}" non esiste: approva prima l'agente`);
  }
  // Le skill salvano i nomi dei tool: devono essere tool dell'app (anche non ancora attivi)
  await resolveTools(tx, appId, skill.toolNames, false);

  const fields = {
    description: skill.description,
    instructions: skill.instructions,
    toolNames: skill.toolNames,
    paramsSchema: skill.paramsSchema,
  };
  const [current] = await tx
    .select({ id: agentSkillsTable.id })
    .from(agentSkillsTable)
    .where(and(eq(agentSkillsTable.agentId, agent.id), eq(agentSkillsTable.name, skill.name)))
    .limit(1);
  if (current) {
    await tx
      .update(agentSkillsTable)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(agentSkillsTable.id, current.id));
  } else {
    await tx.insert(agentSkillsTable).values({ ...fields, agentId: agent.id, name: skill.name });
  }
}

/** Violazione di unicità non prevista dai controlli: si traduce in un errore comprensibile. */
function translateUnique(err: unknown): never {
  if (isUniqueViolation(err, "agent_skills_agent_id_name_unique")) {
    throw new ApplyError("Esiste già una skill con questo nome per l'agente");
  }
  if (isUniqueViolation(err, "app_tools_app_id_name_unique")) {
    throw new ApplyError("Esiste già uno strumento con questo nome nell'app");
  }
  if (isUniqueViolation(err)) throw new ApplyError("L'elemento è in conflitto con uno già presente");
  throw err;
}

/**
 * Applica un elemento approvato alle tabelle di destinazione, in una sola transazione: se qualcosa
 * non è applicabile si lancia `ApplyError` e non resta scritto nulla. Con `tx` si usa la transazione
 * del chiamante (che così può cambiare lo stato dell'elemento atomicamente) e non se ne apre un'altra.
 * `endpoint`, `completion` ed `evolution` non scrivono nulla.
 */
export async function applyItem(item: AnalysisItem, appId: number, tx?: Tx): Promise<void> {
  const run = async (t: Tx): Promise<void> => {
    switch (item.chapter) {
      case "tool":
        return applyTool(t, item, appId);
      case "agent":
        return applyAgent(t, item, appId);
      case "skill":
        return applySkill(t, item, appId);
      default:
        return;
    }
  };
  try {
    await (tx ? run(tx) : db.transaction(run));
  } catch (err) {
    if (err instanceof ApplyError) throw err;
    return translateUnique(err);
  }
}
