import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  appsTable,
  skillsTable,
  teamInstanceSkillsTable,
  teamInstancesTable,
  teamTemplatesTable,
  type TeamInstanceRow,
} from "@workspace/db";
import { InstanceRoleSchema, type InstanceRole, type TemplateRole } from "./manifest";
import { TEAM_MESSAGES, TeamRuleError, validateRoles } from "./rules";
import { SKILL_CODE, SKILL_MESSAGES, validateSkillContent, type Executor, type SkillKind } from "./skills";
import { TEMPLATE_MESSAGES, TemplateError, describeRoles, getTemplateVersion, type LocalSkillInfo, type RoleView } from "./templates";

// Istanze di squadra: copia di un modello (o squadra da zero) legata a un lavoro, con le skill fissate a
// una versione e skill specializzate proprie. La validazione legge dal pool e si fa PRIMA di aprire la
// transazione di scrittura, mai dentro.

export const INSTANCE_MESSAGES = {
  notFound: "squadra non trovata",
  closed: TEAM_MESSAGES.teamClosed,
  refAppNotFound: "app di riferimento inesistente",
  rolesRequired: "senza modello i ruoli sono obbligatori",
  duplicateLocalSkill: (code: string) => `skill specializzata ${code} ripetuta`,
  invalidLocalCode: (code: string) => `codice della skill specializzata ${code} non valido`,
  tooManyLocalSkills: "troppe skill specializzate",
} as const;

const MAX_LOCAL_SKILLS = 100;

export class InstanceError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "InstanceError";
  }
}

export type LocalSkillInput = { code: string; name: string; kind: SkillKind; content: string; toolHints?: string[] };
export type LocalSkillView = { code: string; name: string; kind: SkillKind; content: string; toolHints: string[] };

export type InstanceView = {
  id: number;
  name: string;
  status: "draft" | "active" | "closed";
  template: { id: number; name: string; version: number } | null;
  ref: { appId: number; appName: string; type: string; id: string; title: string };
  roles: RoleView[];
  localSkills: LocalSkillView[];
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

export type CreateInstanceInput = {
  templateId?: number;
  name: string;
  ref: { appId: number; type: string; id: string; title?: string };
  roles?: InstanceRole[];
};

export type SaveInstanceInput = {
  name: string;
  refTitle?: string;
  roles: InstanceRole[];
  localSkills: LocalSkillInput[];
  status?: "draft" | "active";
};

export type InstanceFilter = { status?: "draft" | "active" | "closed"; appId?: number; refType?: string; refId?: string };

async function toView(row: TeamInstanceRow): Promise<InstanceView> {
  const roles = InstanceRoleSchema.array().parse(row.roles);
  const [app] = await db.select({ name: appsTable.name }).from(appsTable).where(eq(appsTable.id, row.refAppId)).limit(1);
  const [template] =
    row.templateId === null
      ? []
      : await db.select({ name: teamTemplatesTable.name }).from(teamTemplatesTable).where(eq(teamTemplatesTable.id, row.templateId)).limit(1);
  const local = await db
    .select()
    .from(teamInstanceSkillsTable)
    .where(eq(teamInstanceSkillsTable.instanceId, row.id))
    .orderBy(teamInstanceSkillsTable.code);
  const info: LocalSkillInfo = new Map(local.map((s) => [s.code, { name: s.name, kind: s.kind }]));
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    template: row.templateId !== null && template && row.templateVersion !== null ? { id: row.templateId, name: template.name, version: row.templateVersion } : null,
    ref: { appId: row.refAppId, appName: app?.name ?? "", type: row.refType, id: row.refId, title: row.refTitle },
    roles: await describeRoles(roles, info),
    localSkills: local.map((s) => ({ code: s.code, name: s.name, kind: s.kind, content: s.content, toolHints: s.toolHints })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

async function getRow(id: number): Promise<TeamInstanceRow> {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, id)).limit(1);
  if (!row) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
  return row;
}

/** Copia i ruoli del modello fissando ogni skill alla sua versione corrente. */
async function pinSkills(roles: TemplateRole[]): Promise<InstanceRole[]> {
  const codes = [...new Set(roles.flatMap((r) => r.skills))];
  const skills = codes.length > 0 ? await db.select().from(skillsTable).where(inArray(skillsTable.code, codes)) : [];
  const versionByCode = new Map(skills.map((s) => [s.code, s.currentVersion]));
  return roles.map((role) => ({
    ...role,
    skills: role.skills.map((code) => {
      const version = versionByCode.get(code);
      if (version === undefined) throw new TeamRuleError(TEAM_MESSAGES.skillNotFound(code));
      return { code, version };
    }),
    localSkills: [],
  }));
}

async function assertAppExists(appId: number): Promise<void> {
  const [app] = await db.select({ id: appsTable.id }).from(appsTable).where(eq(appsTable.id, appId)).limit(1);
  if (!app) throw new TeamRuleError(INSTANCE_MESSAGES.refAppNotFound);
}

export async function createInstance(userId: number, input: CreateInstanceInput, executor: Executor = db): Promise<InstanceView> {
  await assertAppExists(input.ref.appId);

  let roles: InstanceRole[];
  // Ruoli del modello: le skill deprecate o gli strumenti non più usabili restano validi dove il modello già li ha
  let previous: TemplateRole[] | null = null;
  let templateVersion: number | null = null;
  if (input.templateId !== undefined) {
    const [template] = await db.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.id, input.templateId)).limit(1);
    if (!template) throw new TemplateError(404, TEMPLATE_MESSAGES.notFound);
    if (template.archived) throw new TemplateError(409, TEMPLATE_MESSAGES.archived);
    previous = await getTemplateVersion(template.id, template.version);
    roles = await pinSkills(previous);
    templateVersion = template.version;
  } else {
    if (!input.roles) throw new TeamRuleError(INSTANCE_MESSAGES.rolesRequired);
    roles = input.roles;
  }
  await validateRoles({ roles, mode: "instance", userId, previous, localSkillCodes: new Map() });

  const [row] = await executor
    .insert(teamInstancesTable)
    .values({
      name: input.name,
      templateId: input.templateId ?? null,
      templateVersion,
      refAppId: input.ref.appId,
      refType: input.ref.type,
      refId: input.ref.id,
      refTitle: input.ref.title ?? `${input.ref.type} · ${input.ref.id}`,
      roles,
      createdBy: userId,
    })
    .returning();
  return toView(row!);
}

function checkLocalSkills(skills: LocalSkillInput[]): Map<string, SkillKind> {
  if (skills.length > MAX_LOCAL_SKILLS) throw new TeamRuleError(INSTANCE_MESSAGES.tooManyLocalSkills);
  const kinds = new Map<string, SkillKind>();
  for (const skill of skills) {
    if (!SKILL_CODE.test(skill.code)) throw new TeamRuleError(INSTANCE_MESSAGES.invalidLocalCode(skill.code));
    if (kinds.has(skill.code)) throw new TeamRuleError(INSTANCE_MESSAGES.duplicateLocalSkill(skill.code));
    const error = validateSkillContent(skill.kind, skill.content);
    if (error) throw new TeamRuleError(error);
    if (skill.kind === "node" && (skill.toolHints ?? []).length > 0) throw new TeamRuleError(SKILL_MESSAGES.hintsOnlyCasello);
    kinds.set(skill.code, skill.kind);
  }
  return kinds;
}

/**
 * Tutto o niente: valida (fuori dalla transazione) e poi sostituisce ruoli e skill specializzate. Le skill
 * del catalogo già presenti nei ruoli precedenti restano ammesse anche se nel frattempo deprecate.
 */
export async function saveInstance(userId: number, id: number, input: SaveInstanceInput, executor: Executor = db): Promise<InstanceView> {
  const current = await getRow(id);
  if (current.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);
  const localSkillCodes = checkLocalSkills(input.localSkills);
  const previous = InstanceRoleSchema.array().parse(current.roles);
  await validateRoles({ roles: input.roles, mode: "instance", userId, previous, localSkillCodes });

  await executor.transaction(async (tx) => {
    const [locked] = await tx.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, id)).limit(1).for("update");
    if (!locked) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
    if (locked.status === "closed") throw new InstanceError(409, INSTANCE_MESSAGES.closed);
    await tx.delete(teamInstanceSkillsTable).where(eq(teamInstanceSkillsTable.instanceId, id));
    if (input.localSkills.length > 0) {
      await tx.insert(teamInstanceSkillsTable).values(
        input.localSkills.map((s) => ({
          instanceId: id,
          code: s.code,
          name: s.name,
          kind: s.kind,
          content: s.content,
          toolHints: s.toolHints ?? [],
        })),
      );
    }
    await tx
      .update(teamInstancesTable)
      .set({
        name: input.name,
        refTitle: input.refTitle ?? locked.refTitle,
        roles: input.roles,
        status: input.status ?? locked.status,
        updatedAt: new Date(),
      })
      .where(eq(teamInstancesTable.id, id));
  });
  return getInstance(id);
}

/** Chiude la squadra: non si riapre e non si salva più. */
export async function closeInstance(id: number): Promise<InstanceView> {
  await getRow(id);
  const now = new Date();
  const updated = await db
    .update(teamInstancesTable)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(and(eq(teamInstancesTable.id, id), inArray(teamInstancesTable.status, ["draft", "active"])))
    .returning({ id: teamInstancesTable.id });
  if (updated.length === 0) throw new InstanceError(409, INSTANCE_MESSAGES.closed);
  return getInstance(id);
}

export async function getInstance(id: number): Promise<InstanceView> {
  return toView(await getRow(id));
}

export async function listInstances(filter: InstanceFilter = {}): Promise<InstanceView[]> {
  const conditions = [];
  if (filter.status) conditions.push(eq(teamInstancesTable.status, filter.status));
  if (filter.appId !== undefined) conditions.push(eq(teamInstancesTable.refAppId, filter.appId));
  if (filter.refType !== undefined) conditions.push(eq(teamInstancesTable.refType, filter.refType));
  if (filter.refId !== undefined) conditions.push(eq(teamInstancesTable.refId, filter.refId));
  const rows = await db
    .select()
    .from(teamInstancesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(teamInstancesTable.updatedAt), desc(teamInstancesTable.id));
  return Promise.all(rows.map(toView));
}
