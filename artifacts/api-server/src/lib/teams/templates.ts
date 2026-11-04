import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  aiModelsTable,
  appToolsTable,
  appsTable,
  skillsTable,
  teamInstancesTable,
  teamTemplateVersionsTable,
  teamTemplatesTable,
  type TeamTemplateRow,
} from "@workspace/db";
import { isUniqueViolation } from "../pg-errors";
import { effectiveLevel, type ToolLevel } from "../tools/levels";
import { TemplateRoleSchema, type InstanceRole, type TemplateRole } from "./manifest";
import { validateRoles } from "./rules";
import type { Executor, SkillKind } from "./skills";

// Modelli di squadra: nome, descrizione e, per ogni versione, il manifesto dei ruoli. Ogni salvataggio
// crea la versione successiva (le precedenti restano leggibili). Le letture arricchiscono i ruoli con i
// nomi di strumenti, skill e modelli (`describeRoles`, usata anche dalle istanze).

export const TEMPLATE_MESSAGES = {
  notFound: "modello non trovato",
  versionNotFound: "versione non trovata",
  duplicateName: "nome già usato",
  archived: "modello archiviato",
  deletedTool: "strumento eliminato",
} as const;

export class TemplateError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

export type ToolView = { id: number; appId?: number; appName?: string; name: string; level?: ToolLevel; available: boolean };
export type SkillRoleView = { code: string; version?: number; name: string; kind: SkillKind; deprecated: boolean; local?: boolean };
export type RoleView = {
  key: string;
  name: string;
  task: string;
  isLead: boolean;
  runsOn: "cloud" | "node";
  model: { id: number; name: string } | null;
  tools: ToolView[];
  skills: SkillRoleView[];
};

export type TemplateView = {
  id: number;
  name: string;
  description: string;
  version: number;
  archived: boolean;
  instanceCount: number;
  roles: RoleView[];
  createdAt: Date;
  updatedAt: Date;
};

export type TemplateInput = { name: string; description?: string; roles: TemplateRole[] };

/** Skill specializzate di un'istanza: nome e tipo per codice (servono solo a leggere i ruoli di un'istanza). */
export type LocalSkillInfo = Map<string, { name: string; kind: SkillKind }>;

export async function describeRoles(
  roles: TemplateRole[] | InstanceRole[],
  localSkills: LocalSkillInfo = new Map(),
): Promise<RoleView[]> {
  const list: Array<TemplateRole | InstanceRole> = roles;
  const toolIds = [...new Set(list.flatMap((r) => r.tools))];
  const codes = [...new Set(list.flatMap((r) => r.skills.map((s) => (typeof s === "string" ? s : s.code))))];
  const modelIds = [...new Set(list.flatMap((r) => (r.aiModelId === null ? [] : [r.aiModelId])))];

  const tools =
    toolIds.length > 0
      ? await db
          .select({ tool: appToolsTable, appName: appsTable.name })
          .from(appToolsTable)
          .innerJoin(appsTable, eq(appsTable.id, appToolsTable.appId))
          .where(inArray(appToolsTable.id, toolIds))
      : [];
  const toolById = new Map(tools.map((t) => [t.tool.id, t]));
  const skills = codes.length > 0 ? await db.select().from(skillsTable).where(inArray(skillsTable.code, codes)) : [];
  const skillByCode = new Map(skills.map((s) => [s.code, s]));
  const models =
    modelIds.length > 0
      ? await db
          .select({ id: aiModelsTable.id, name: aiModelsTable.displayName })
          .from(aiModelsTable)
          .where(inArray(aiModelsTable.id, modelIds))
      : [];
  const modelById = new Map(models.map((m) => [m.id, m]));

  return list.map((role) => {
    const roleTools: ToolView[] = role.tools.map((id) => {
      const found = toolById.get(id);
      if (!found) return { id, name: TEMPLATE_MESSAGES.deletedTool, available: false };
      const level = effectiveLevel(found.tool);
      return {
        id,
        appId: found.tool.appId,
        appName: found.appName,
        name: found.tool.name,
        level,
        available: found.tool.status === "active" && level !== "L3",
      };
    });
    const catalogSkills: SkillRoleView[] = role.skills.map((item) => {
      const code = typeof item === "string" ? item : item.code;
      const skill = skillByCode.get(code);
      const view: SkillRoleView = {
        code,
        name: skill?.name ?? code,
        kind: skill?.kind ?? "casello",
        deprecated: skill?.deprecated ?? false,
      };
      if (typeof item !== "string") view.version = item.version;
      return view;
    });
    const local = "localSkills" in role ? role.localSkills : [];
    const localViews: SkillRoleView[] = local.map((code) => {
      const info = localSkills.get(code);
      return { code, name: info?.name ?? code, kind: info?.kind ?? "casello", deprecated: false, local: true };
    });
    const model = role.aiModelId === null ? null : (modelById.get(role.aiModelId) ?? null);
    return {
      key: role.key,
      name: role.name,
      task: role.task,
      isLead: role.isLead,
      runsOn: role.runsOn,
      model,
      tools: roleTools,
      skills: [...catalogSkills, ...localViews],
    };
  });
}

async function toView(row: TeamTemplateRow, roles: TemplateRole[]): Promise<TemplateView> {
  const [{ value }] = (await db
    .select({ value: count() })
    .from(teamInstancesTable)
    .where(eq(teamInstancesTable.templateId, row.id))) as [{ value: number }];
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    archived: row.archived,
    instanceCount: value,
    roles: await describeRoles(roles),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function readVersion(templateId: number, version: number, executor: Pick<typeof db, "select"> = db): Promise<TemplateRole[]> {
  const [row] = await executor
    .select()
    .from(teamTemplateVersionsTable)
    .where(and(eq(teamTemplateVersionsTable.templateId, templateId), eq(teamTemplateVersionsTable.version, version)))
    .limit(1);
  if (!row) throw new TemplateError(404, TEMPLATE_MESSAGES.versionNotFound);
  return TemplateRoleSchema.array().parse(row.manifest);
}

/** Scrive modello e versione 1 senza validare: chi chiama ha già validato i ruoli (fuori da ogni transazione). */
export async function insertTemplateUnchecked(input: TemplateInput, executor: Executor = db): Promise<number> {
  try {
    return await executor.transaction(async (tx) => {
      const [row] = await tx
        .insert(teamTemplatesTable)
        .values({ name: input.name, description: input.description ?? "" })
        .returning({ id: teamTemplatesTable.id });
      await tx.insert(teamTemplateVersionsTable).values({ templateId: row!.id, version: 1, manifest: input.roles });
      return row!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err, "team_templates_name_active_unique")) {
      throw new TemplateError(409, TEMPLATE_MESSAGES.duplicateName);
    }
    throw err;
  }
}

export async function createTemplate(userId: number, input: TemplateInput, executor: Executor = db): Promise<TemplateView> {
  await validateRoles({ roles: input.roles, mode: "template", userId, previous: null });
  return getTemplate(await insertTemplateUnchecked(input, executor));
}

/**
 * Crea la versione successiva (e la restituisce) senza validare i ruoli (già validati da chi chiama). La riga del modello si
 * blocca (FOR UPDATE) per non assegnare lo stesso numero a due salvataggi concorrenti.
 */
export async function appendTemplateVersionUnchecked(id: number, input: TemplateInput, executor: Executor = db): Promise<number> {
  try {
    return await executor.transaction(async (tx) => {
      const [locked] = await tx.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.id, id)).limit(1).for("update");
      if (!locked) throw new TemplateError(404, TEMPLATE_MESSAGES.notFound);
      if (locked.archived) throw new TemplateError(409, TEMPLATE_MESSAGES.archived);
      const version = locked.version + 1;
      await tx.insert(teamTemplateVersionsTable).values({ templateId: id, version, manifest: input.roles });
      await tx
        .update(teamTemplatesTable)
        .set({ name: input.name, description: input.description ?? "", version, updatedAt: new Date() })
        .where(eq(teamTemplatesTable.id, id));
      return version;
    });
  } catch (err) {
    if (isUniqueViolation(err, "team_templates_name_active_unique")) {
      throw new TemplateError(409, TEMPLATE_MESSAGES.duplicateName);
    }
    throw err;
  }
}

/** Tutto o niente: valida i ruoli rispetto a quelli della versione corrente e crea la versione successiva. */
export async function saveTemplate(userId: number, id: number, input: TemplateInput, executor: Executor = db): Promise<TemplateView> {
  const current = await getTemplateRow(id);
  if (current.archived) throw new TemplateError(409, TEMPLATE_MESSAGES.archived);
  const previous = await readVersion(id, current.version);
  await validateRoles({ roles: input.roles, mode: "template", userId, previous });
  await appendTemplateVersionUnchecked(id, input, executor);
  return getTemplate(id);
}

export async function getTemplateRow(id: number): Promise<TeamTemplateRow> {
  const [row] = await db.select().from(teamTemplatesTable).where(eq(teamTemplatesTable.id, id)).limit(1);
  if (!row) throw new TemplateError(404, TEMPLATE_MESSAGES.notFound);
  return row;
}

export async function getTemplate(id: number): Promise<TemplateView> {
  const row = await getTemplateRow(id);
  return toView(row, await readVersion(id, row.version));
}

export async function listTemplates({ archived }: { archived: boolean }): Promise<TemplateView[]> {
  const rows = await db
    .select()
    .from(teamTemplatesTable)
    .where(eq(teamTemplatesTable.archived, archived))
    .orderBy(desc(teamTemplatesTable.createdAt), desc(teamTemplatesTable.id));
  return Promise.all(rows.map(async (row) => toView(row, await readVersion(row.id, row.version))));
}

/** I ruoli di una versione del modello (anche non corrente), arricchiti per la lettura. */
export async function getTemplateVersion(id: number, version: number): Promise<TemplateRole[]> {
  await getTemplateRow(id);
  return readVersion(id, version);
}

/** Senza istanze si cancella (le versioni seguono); con istanze si archivia, perché le istanze ne ricordano l'origine. */
export async function deleteTemplate(id: number): Promise<{ deleted: boolean; archived: boolean }> {
  await getTemplateRow(id);
  const [{ value }] = (await db.select({ value: count() }).from(teamInstancesTable).where(eq(teamInstancesTable.templateId, id))) as [
    { value: number },
  ];
  if (value === 0) {
    await db.delete(teamTemplatesTable).where(eq(teamTemplatesTable.id, id));
    return { deleted: true, archived: false };
  }
  await db.update(teamTemplatesTable).set({ archived: true, updatedAt: new Date() }).where(eq(teamTemplatesTable.id, id));
  return { deleted: false, archived: true };
}
