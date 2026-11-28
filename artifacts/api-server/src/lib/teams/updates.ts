import { eq, inArray } from "drizzle-orm";
import { db, skillsTable, teamInstanceSkillsTable, teamInstancesTable, teamTemplatesTable, type TeamInstanceRow } from "@workspace/db";
import { InstanceRoleSchema, type InstanceRole, type TemplateRole } from "./manifest";
import { TEAM_MESSAGES, TeamRuleError, validateRoles } from "./rules";
import type { Executor } from "./skills";
import { checkLinks, getTemplateLinks, getTemplateVersion } from "./templates";
import { linkId, pruneLinks, readLinks, type RoleLink } from "./links";
import { INSTANCE_MESSAGES, InstanceError, getInstance, loadRefApp, type InstanceView } from "./instances";

// Aggiornamenti proposti a un'istanza (spec §4): differenze tra la versione del modello copiata e quella
// corrente (confronto di contenuto per `key`, non di numeri di versione) e skill del catalogo fissate a una
// versione non più recente. L'utente sceglie quali applicare.

export const UPDATE_MESSAGES = {
  changed: "aggiornamenti cambiati: ricarica",
} as const;

export const ROLE_FIELDS = ["name", "task", "isLead", "runsOn", "aiModelId", "tools", "code"] as const;
export type RoleField = (typeof ROLE_FIELDS)[number];

export type UpdateType =
  | "role_added"
  | "role_removed"
  | "role_changed"
  | "skill_added"
  | "skill_removed"
  | "skill_version"
  | "link_added"
  | "link_removed";

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
  /** Solo `link_added` / `link_removed`: la relazione (con la modalità proposta per `link_added`) */
  link?: RoleLink;
};

export interface ComputeUpdatesInput {
  /** Manifesto della versione del modello copiata dall'istanza (null senza modello). */
  base: TemplateRole[] | null;
  /** Manifesto della versione corrente del modello (null senza modello). */
  current: TemplateRole[] | null;
  instance: InstanceRole[];
  /** Versione corrente di ogni skill del catalogo, per codice. */
  skillVersions: Map<string, number>;
  /** Relazioni della versione copiata, della versione corrente e dell'istanza (assenti = nessuna). */
  baseLinks?: RoleLink[];
  currentLinks?: RoleLink[];
  instanceLinks?: RoleLink[];
}

const pairOf = (l: Pick<RoleLink, "from" | "to">): string => `${l.from}\u0000${l.to}`;

/**
 * Voci delle relazioni, con la stessa regola dei ruoli: compaiono solo dove la versione corrente differisce da quella copiata
 * e l'istanza non ha già il valore proposto (una relazione cambiata di modalità è un `link_added` con la modalità nuova).
 */
function linkUpdates(input: ComputeUpdatesInput): UpdateItem[] {
  if (!input.base || !input.current) return [];
  const base = new Map((input.baseLinks ?? []).map((l) => [pairOf(l), l]));
  const current = new Map((input.currentLinks ?? []).map((l) => [pairOf(l), l]));
  const mine = new Map((input.instanceLinks ?? []).map((l) => [pairOf(l), l]));
  const roleName = new Map(input.instance.map((r) => [r.key, r.name]));
  const items: UpdateItem[] = [];
  for (const [pair, link] of current) {
    const before = base.get(pair);
    const own = mine.get(pair);
    if (before && before.mode === link.mode) continue;
    if (own && own.mode === link.mode) continue;
    // Una relazione tra ruoli che l'istanza non ha (ancora): arriverà con l'aggiornamento del ruolo, poi si ripropone
    if (!roleName.has(link.from) || !roleName.has(link.to)) continue;
    items.push({ id: linkId(link), type: "link_added", roleKey: link.from, roleName: roleName.get(link.from)!, link });
  }
  for (const [pair, link] of base) {
    if (current.has(pair) || !mine.has(pair)) continue;
    items.push({ id: `${linkId(link)}:removed`, type: "link_removed", roleKey: link.from, roleName: roleName.get(link.from) ?? link.from, link });
  }
  return items;
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
  items.push(...linkUpdates(input));
  return items;
}

/** Applica alle relazioni dell'istanza le voci scelte (già verificate tra quelle attuali). */
function applyLinkItems(links: RoleLink[], items: UpdateItem[]): RoleLink[] {
  const result = new Map(links.map((l) => [pairOf(l), l]));
  for (const item of items) {
    if (!item.link) continue;
    if (item.type === "link_added") result.set(pairOf(item.link), item.link);
    if (item.type === "link_removed") result.delete(pairOf(item.link));
  }
  return [...result.values()];
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
  links: RoleLink[];
  baseLinks: RoleLink[];
  currentLinks: RoleLink[];
};

async function loadContext(instanceId: number): Promise<UpdateContext> {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!row) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
  if (row.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);
  const roles = InstanceRoleSchema.array().parse(row.roles);

  let base: TemplateRole[] | null = null;
  let current: TemplateRole[] | null = null;
  let currentVersion: number | null = null;
  let baseLinks: RoleLink[] = [];
  let currentLinks: RoleLink[] = [];
  if (row.templateId !== null && row.templateVersion !== null) {
    const [template] = await db.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.id, row.templateId)).limit(1);
    if (template) {
      base = await getTemplateVersion(template.id, row.templateVersion);
      current = await getTemplateVersion(template.id, template.version);
      currentVersion = template.version;
      baseLinks = await getTemplateLinks(template.id, row.templateVersion);
      currentLinks = await getTemplateLinks(template.id, template.version);
    }
  }

  // Versioni correnti delle skill dell'istanza e di quelle che il modello potrebbe aggiungere
  const codes = [...new Set([...roles.flatMap((r) => r.skills.map((s) => s.code)), ...(current ?? []).flatMap((r) => r.skills)])];
  const skills =
    codes.length > 0
      ? await db.select({ code: skillsTable.code, currentVersion: skillsTable.currentVersion }).from(skillsTable).where(inArray(skillsTable.code, codes))
      : [];
  const skillVersions = new Map(skills.map((s) => [s.code, s.currentVersion]));
  return { row, roles, base, current, currentVersion, skillVersions, links: readLinks(row.links), baseLinks, currentLinks };
}

export async function getUpdates(instanceId: number): Promise<UpdateItem[]> {
  const { roles, base, current, skillVersions, links, baseLinks, currentLinks } = await loadContext(instanceId);
  return computeUpdates({ base, current, instance: roles, skillVersions, baseLinks, currentLinks, instanceLinks: links });
}

/**
 * Applica le voci scelte: tutto o niente. Una voce non più tra quelle attuali, o un'istanza cambiata tra il
 * calcolo e la scrittura, dà 409 «aggiornamenti cambiati: ricarica». Validazione fuori dalla transazione.
 * Se dopo l'applicazione non restano voci del modello, l'istanza passa alla versione corrente del modello.
 */
export async function applyUpdates(userId: number, instanceId: number, ids: string[], executor: Executor = db): Promise<InstanceView> {
  const { row, roles, base, current, currentVersion, skillVersions, links, baseLinks, currentLinks } = await loadContext(instanceId);
  const items = computeUpdates({ base, current, instance: roles, skillVersions, baseLinks, currentLinks, instanceLinks: links });
  const byId = new Map(items.map((item) => [item.id, item]));
  if (ids.some((id) => !byId.has(id))) throw new InstanceError(409, UPDATE_MESSAGES.changed);
  const chosen = new Set(ids);
  const picked = items.filter((item) => chosen.has(item.id));
  const next = applyItems(roles, picked, skillVersions);
  // Le relazioni dei ruoli tolti spariscono con loro
  const nextLinks = pruneLinks(next, applyLinkItems(links, picked));

  const local = await db
    .select({ code: teamInstanceSkillsTable.code, kind: teamInstanceSkillsTable.kind })
    .from(teamInstanceSkillsTable)
    .where(eq(teamInstanceSkillsTable.instanceId, instanceId));
  await validateRoles({ roles: next, mode: "instance", userId, previous: roles, localSkillCodes: new Map(local.map((s) => [s.code, s.kind])), refApp: await loadRefApp(row.refAppId) });
  checkLinks(next, nextLinks);

  const remaining = computeUpdates({ base, current, instance: next, skillVersions, baseLinks, currentLinks, instanceLinks: nextLinks });
  const templateVersion =
    currentVersion !== null && !remaining.some((item) => item.type !== "skill_version") ? currentVersion : row.templateVersion;

  await executor.transaction(async (tx) => {
    const [locked] = await tx.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1).for("update");
    if (!locked) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
    if (locked.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);
    if (
      locked.templateVersion !== row.templateVersion ||
      JSON.stringify(locked.roles) !== JSON.stringify(row.roles) ||
      JSON.stringify(locked.links) !== JSON.stringify(row.links)
    ) {
      throw new InstanceError(409, UPDATE_MESSAGES.changed);
    }
    await tx
      .update(teamInstancesTable)
      .set({ roles: next, links: nextLinks, templateVersion, updatedAt: new Date() })
      .where(eq(teamInstancesTable.id, instanceId));
  });
  return getInstance(instanceId);
}
