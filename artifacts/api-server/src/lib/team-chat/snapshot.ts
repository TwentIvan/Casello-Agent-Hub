// Lettura della squadra per la chat di Lucius: ruoli, strumenti (senza definizioni né indirizzi), skill con il
// contenuto alla versione fissata e specializzate, PLAN se esiste. Non crea il PLAN se manca.

import { eq, inArray } from "drizzle-orm";
import {
  db,
  aiModelsTable,
  appToolsTable,
  appsTable,
  skillVersionsTable,
  skillsTable,
  teamInstanceSkillsTable,
  teamInstancesTable,
  teamPlansTable,
  teamTemplatesTable,
} from "@workspace/db";
import { InstanceError, INSTANCE_MESSAGES } from "../teams/instances";
import { InstanceRoleSchema } from "../teams/manifest";
import { TEMPLATE_MESSAGES } from "../teams/templates";
import { effectiveLevel } from "../tools/levels";
import type { SnapshotSkill, SnapshotTool, TeamSnapshot } from "./context";

export async function loadTeamSnapshot(instanceId: number): Promise<TeamSnapshot> {
  const [row] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!row) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);
  const roles = InstanceRoleSchema.array().parse(row.roles);

  const [app] = await db.select({ name: appsTable.name }).from(appsTable).where(eq(appsTable.id, row.refAppId)).limit(1);
  const [template] =
    row.templateId === null
      ? []
      : await db.select({ name: teamTemplatesTable.name }).from(teamTemplatesTable).where(eq(teamTemplatesTable.id, row.templateId)).limit(1);

  const toolIds = [...new Set(roles.flatMap((r) => r.tools))];
  const tools =
    toolIds.length > 0
      ? await db
          .select({ tool: appToolsTable, appName: appsTable.name })
          .from(appToolsTable)
          .innerJoin(appsTable, eq(appsTable.id, appToolsTable.appId))
          .where(inArray(appToolsTable.id, toolIds))
      : [];
  const toolById = new Map(tools.map((t) => [t.tool.id, t]));

  const modelIds = [...new Set(roles.flatMap((r) => (r.aiModelId === null ? [] : [r.aiModelId])))];
  const models =
    modelIds.length > 0 ? await db.select({ id: aiModelsTable.id, name: aiModelsTable.displayName }).from(aiModelsTable).where(inArray(aiModelsTable.id, modelIds)) : [];
  const modelById = new Map(models.map((m) => [m.id, m.name]));

  const codes = [...new Set(roles.flatMap((r) => r.skills.map((s) => s.code)))];
  const versions =
    codes.length > 0
      ? await db
          .select({ code: skillsTable.code, name: skillsTable.name, kind: skillsTable.kind, version: skillVersionsTable.version, content: skillVersionsTable.content })
          .from(skillVersionsTable)
          .innerJoin(skillsTable, eq(skillVersionsTable.skillId, skillsTable.id))
          .where(inArray(skillsTable.code, codes))
      : [];
  const local = await db.select().from(teamInstanceSkillsTable).where(eq(teamInstanceSkillsTable.instanceId, instanceId)).orderBy(teamInstanceSkillsTable.code);
  const localByCode = new Map(local.map((s) => [s.code, s]));

  const [plan] = await db.select().from(teamPlansTable).where(eq(teamPlansTable.instanceId, instanceId)).limit(1);

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ref: { appName: app?.name ?? "", type: row.refType, id: row.refId, title: row.refTitle },
    template: row.templateId !== null && template && row.templateVersion !== null ? { name: template.name, version: row.templateVersion } : null,
    roles: roles.map((r) => ({
      key: r.key,
      name: r.name,
      task: r.task,
      isLead: r.isLead,
      runsOn: r.runsOn,
      modelName: r.aiModelId === null ? null : (modelById.get(r.aiModelId) ?? null),
      tools: r.tools.map((id): SnapshotTool => {
        const found = toolById.get(id);
        if (!found) return { id, name: TEMPLATE_MESSAGES.deletedTool, appName: null, description: null, level: null, available: false };
        const level = effectiveLevel(found.tool);
        return {
          id,
          name: found.tool.name,
          appName: found.appName,
          description: found.tool.description,
          level,
          available: found.tool.status === "active" && level !== "L3",
        };
      }),
      skills: [
        ...r.skills.flatMap((pinned): SnapshotSkill[] => {
          const v = versions.find((x) => x.code === pinned.code && x.version === pinned.version);
          return v ? [{ code: v.code, name: v.name, kind: v.kind, version: v.version, local: false, content: v.content }] : [];
        }),
        ...r.localSkills.flatMap((code): SnapshotSkill[] => {
          const s = localByCode.get(code);
          return s ? [{ code, name: s.name, kind: s.kind, version: null, local: true, content: s.content }] : [];
        }),
      ],
    })),
    localSkills: local.map((s) => ({ code: s.code, name: s.name, kind: s.kind, content: s.content })),
    plan: plan
      ? {
          objective: plan.objective,
          constraints: plan.constraints,
          tasks: plan.tasks.map((t) => ({ id: t.id, title: t.title, roleKey: t.roleKey, status: t.status })),
        }
      : null,
  };
}
