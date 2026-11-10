import { eq, inArray } from "drizzle-orm";
import { db, skillsTable, teamInstanceSkillsTable, teamInstancesTable, teamTemplatesTable, type TeamInstanceRow } from "@workspace/db";
import { InstanceRoleSchema, type InstanceRole, type TemplateRole } from "./manifest";
import { TEAM_MESSAGES, TeamRuleError, validateRoles } from "./rules";
import type { Executor } from "./skills";
import { getTemplateVersion } from "./templates";
import { INSTANCE_MESSAGES, InstanceError, getInstance, loadRefApp, type InstanceView } from "./instances";

// Aggiornamenti proposti a un'istanza (spec §4): differenze tra la versione del modello copiata e quella
// corrente (confronto di contenuto per `key`, non di numeri di versione) e skill del catalogo fissate a una
// versione non più recente. L'utente sceglie quali applicare.

export const UPDATE_MESSAGES = {
  changed: "aggiornamenti cambiati: ricarica",
} as const;

export const ROLE_FIELDS = ["name", "task", "isLead", "runsOn", "aiModelId", "tools", "code"] as const;
export type RoleField = (typeof ROLE_FIELDS)[number];

export type UpdateType = "role_added" | "role_removed" | "role_changed" | "skill_added" | "skill_removed" | "skill_version";

export type UpdateItem = {
  id: string;
  type: UpdateType;
  roleKey: string;
  roleName: string;
  field?: RoleField;
  from?: unknown;
  to?: unknown;
  skillCode?: string;
  fromVersion?: number;
  toVersion?: number;
};

export interface ComputeUpdatesInput {
  /** Manifesto della versione del modello copiata dall'istanza (null senza modello). */
  base: TemplateRole[] | null;
  /** Manifesto della versione corrente del modello (null senza modello). */
  current: TemplateRole[] | null;
  instance: InstanceRole[];
  /** Versione corrente di ogni skill del catalogo, per codice. */
  skillVersions: Map<string, number>;
}

function sameField(field: RoleField, a: unknown, b: unknown): boolean {
  if (field === "tools") {
    const left = new Set(a as number[]);
    const right = new Set(b as number[]);
    return left.size === right.size && [...left].every((id) => right.has(id));
  }
  return a === b;
}

/**
 * Puro. Le voci del modello compaiono solo dove `current` differisce da `base` e l'istanza non ha già il
 * valore proposto: così un'applicazione fa sparire la voce e una nuova versione identica non propone nulla.
 */
export function computeUpdates(input: ComputeUpdatesInput): UpdateItem[] {
  const { base, current, instance, skillVersions } = input;
  const items: UpdateItem[] = [];
  const instanceByKey = new Map(instance.map((r) => [r.key, r]));

  if (base && current) {
    const baseByKey = new Map(base.map((r) => [r.key, r]));
    const currentKeys = new Set(current.map((r) => r.key));
    for (const role of current) {
      const before = baseByKey.get(role.key);
      const mine = instanceByKey.get(role.key);
      if (!before) {
        if (!mine) items.push({ id: `role_added:${role.key}`, type: "role_added", roleKey: role.key, roleName: role.name, to: role });
        continue;
      }
      if (!mine) continue;
      for (const field of ROLE_FIELDS) {
        if (sameField(field, before[field], role[field]) || sameField(field, mine[field], role[field])) continue;
        items.push({
          id: `role_changed:${role.key}:${field}`,
          type: "role_changed",
          roleKey: role.key,
          roleName: mine.name,
          field,
          from: mine[field],
          to: role[field],
        });
      }
      const mineCodes = new Set(mine.skills.map((s) => s.code));
      const beforeCodes = new Set(before.skills);
      const nowCodes = new Set(role.skills);
      for (const code of role.skills) {
        if (beforeCodes.has(code) || mineCodes.has(code)) continue;
        items.push({ id: `skill_added:${role.key}:${code}`, type: "skill_added", roleKey: role.key, roleName: mine.name, skillCode: code });
      }
      for (const code of before.skills) {
        if (nowCodes.has(code) || !mineCodes.has(code)) continue;
        items.push({ id: `skill_removed:${role.key}:${code}`, type: "skill_removed", roleKey: role.key, roleName: mine.name, skillCode: code });
      }
    }
    for (const role of base) {
      const mine = instanceByKey.get(role.key);
      if (currentKeys.has(role.key) || !mine) continue;
      items.push({ id: `role_removed:${role.key}`, type: "role_removed", roleKey: role.key, roleName: mine.name });
    }
  }

  for (const role of instance) {
    for (const skill of role.skills) {
      const latest = skillVersions.get(skill.code);
      if (latest === undefined || skill.version >= latest) continue;
      items.push({
        id: `skill_version:${role.key}:${skill.code}`,
        type: "skill_version",
        roleKey: role.key,
        roleName: role.name,
        skillCode: skill.code,
        fromVersion: skill.version,
        toVersion: latest,
      });
    }
  }
  return items;
}

function latestVersion(skillVersions: Map<string, number>, code: string): number {
  const version = skillVersions.get(code);
  if (version === undefined) throw new TeamRuleError(TEAM_MESSAGES.skillNotFound(code));
  return version;
}

/** Applica in memoria le voci scelte (già verificate tra quelle attuali) ai ruoli dell'istanza. */
function applyItems(roles: InstanceRole[], items: UpdateItem[], skillVersions: Map<string, number>): InstanceRole[] {
  let result = roles.map((r) => ({ ...r, tools: [...r.tools], skills: r.skills.map((s) => ({ ...s })), localSkills: [...r.localSkills] }));
  const roleOf = (key: string): InstanceRole | undefined => result.find((r) => r.key === key);
  for (const item of items) {
    switch (item.type) {
      case "role_added": {
        const role = item.to as TemplateRole;
        result.push({
          ...role,
          tools: [...role.tools],
          skills: role.skills.map((code) => ({ code, version: latestVersion(skillVersions, code) })),
          localSkills: [],
        });
        break;
      }
      case "role_removed":
        result = result.filter((r) => r.key !== item.roleKey);
        break;
      case "role_changed": {
        const role = roleOf(item.roleKey);
        if (role) Object.assign(role, { [item.field!]: item.field === "tools" ? [...(item.to as number[])] : item.to });
        break;
      }
      case "skill_added": {
        const role = roleOf(item.roleKey);
        if (role && !role.skills.some((s) => s.code === item.skillCode)) {
          role.skills.push({ code: item.skillCode!, version: latestVersion(skillVersions, item.skillCode!) });
        }
        break;
      }
      case "skill_removed": {
        const role = roleOf(item.roleKey);
        if (role) role.skills = role.skills.filter((s) => s.code !== item.skillCode);
        break;
      }
      case "skill_version": {
        const skill = roleOf(item.roleKey)?.skills.find((s) => s.code === item.skillCode);
        if (skill) skill.version = item.toVersion!;
        break;
      }
    }
  }
  return result;
}

type UpdateContext = {
  row: TeamInstanceRow;
  roles: InstanceRole[];
  base: TemplateRole[] | null;
  current: TemplateRole[] | null;
  currentVersion: number | null;
  skillVersions: Map<string, number>;
};

async function loadContext(instanceId: number): Promise<UpdateContext> {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!row) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
  if (row.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);
  const roles = InstanceRoleSchema.array().parse(row.roles);

  let base: TemplateRole[] | null = null;
  let current: TemplateRole[] | null = null;
  let currentVersion: number | null = null;
  if (row.templateId !== null && row.templateVersion !== null) {
    const [template] = await db.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.id, row.templateId)).limit(1);
    if (template) {
      base = await getTemplateVersion(template.id, row.templateVersion);
      current = await getTemplateVersion(template.id, template.version);
      currentVersion = template.version;
    }
  }

  // Versioni correnti delle skill dell'istanza e di quelle che il modello potrebbe aggiungere
  const codes = [...new Set([...roles.flatMap((r) => r.skills.map((s) => s.code)), ...(current ?? []).flatMap((r) => r.skills)])];
  const skills =
    codes.length > 0
      ? await db.select({ code: skillsTable.code, currentVersion: skillsTable.currentVersion }).from(skillsTable).where(inArray(skillsTable.code, codes))
      : [];
  const skillVersions = new Map(skills.map((s) => [s.code, s.currentVersion]));
  return { row, roles, base, current, currentVersion, skillVersions };
}

export async function getUpdates(instanceId: number): Promise<UpdateItem[]> {
  const { roles, base, current, skillVersions } = await loadContext(instanceId);
  return computeUpdates({ base, current, instance: roles, skillVersions });
}

/**
 * Applica le voci scelte: tutto o niente. Una voce non più tra quelle attuali, o un'istanza cambiata tra il
 * calcolo e la scrittura, dà 409 «aggiornamenti cambiati: ricarica». Validazione fuori dalla transazione.
 * Se dopo l'applicazione non restano voci del modello, l'istanza passa alla versione corrente del modello.
 */
export async function applyUpdates(userId: number, instanceId: number, ids: string[], executor: Executor = db): Promise<InstanceView> {
  const { row, roles, base, current, currentVersion, skillVersions } = await loadContext(instanceId);
  const items = computeUpdates({ base, current, instance: roles, skillVersions });
  const byId = new Map(items.map((item) => [item.id, item]));
  if (ids.some((id) => !byId.has(id))) throw new InstanceError(409, UPDATE_MESSAGES.changed);
  const chosen = new Set(ids);
  const next = applyItems(
    roles,
    items.filter((item) => chosen.has(item.id)),
    skillVersions,
  );

  const local = await db
    .select({ code: teamInstanceSkillsTable.code, kind: teamInstanceSkillsTable.kind })
    .from(teamInstanceSkillsTable)
    .where(eq(teamInstanceSkillsTable.instanceId, instanceId));
  await validateRoles({ roles: next, mode: "instance", userId, previous: roles, localSkillCodes: new Map(local.map((s) => [s.code, s.kind])), refApp: await loadRefApp(row.refAppId) });

  const remaining = computeUpdates({ base, current, instance: next, skillVersions });
  const templateVersion =
    currentVersion !== null && !remaining.some((item) => item.type !== "skill_version") ? currentVersion : row.templateVersion;

  await executor.transaction(async (tx) => {
    const [locked] = await tx.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1).for("update");
    if (!locked) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
    if (locked.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);
    if (locked.templateVersion !== row.templateVersion || JSON.stringify(locked.roles) !== JSON.stringify(row.roles)) {
      throw new InstanceError(409, UPDATE_MESSAGES.changed);
    }
    await tx
      .update(teamInstancesTable)
      .set({ roles: next, templateVersion, updatedAt: new Date() })
      .where(eq(teamInstancesTable.id, instanceId));
  });
  return getInstance(instanceId);
}
