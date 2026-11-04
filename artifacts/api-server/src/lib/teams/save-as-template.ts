import { and, eq, inArray } from "drizzle-orm";
import { db, skillsTable, teamInstanceSkillsTable, teamInstancesTable } from "@workspace/db";
import { InstanceRoleSchema, type InstanceRole, type TemplateRole } from "./manifest";
import { INSTANCE_MESSAGES, InstanceError } from "./instances";
import { TEAM_MESSAGES, TeamRuleError, validateRoles } from "./rules";
import { SKILL_CODE, SKILL_MESSAGES, SkillError, createSkill } from "./skills";
import {
  TEMPLATE_MESSAGES,
  TemplateError,
  appendTemplateVersionUnchecked,
  getTemplate,
  getTemplateRow,
  getTemplateVersion,
  insertTemplateUnchecked,
  type TemplateView,
} from "./templates";

// «Salva come modello»: l'istanza torna a essere un modello, nuovo o versione successiva di quello d'origine.
// Le skill specializzate promosse entrano nel catalogo (v1) con un codice nuovo; le altre vengono tolte.
// La validazione legge dal pool e precede la transazione di scrittura (tutto o niente).

export const SAVE_AS_TEMPLATE_MESSAGES = {
  nameRequired: "il nome del modello è obbligatorio",
  noTemplate: "l'istanza non ha un modello",
  duplicatePromotion: (code: string) => `codice ${code} ripetuto nelle promozioni`,
} as const;

export type SaveAsTemplateInput = {
  mode: "new" | "new_version";
  name?: string;
  promote?: { localCode: string; code: string }[];
};

export async function saveInstanceAsTemplate(userId: number, instanceId: number, input: SaveAsTemplateInput): Promise<TemplateView> {
  const [instance] = await db.select().from(teamInstancesTable).where(eq(teamInstancesTable.id, instanceId)).limit(1);
  if (!instance) throw new InstanceError(404, INSTANCE_MESSAGES.notFound);

  const name = input.name?.trim() ?? "";
  if (input.mode === "new" && name.length === 0) throw new TeamRuleError(SAVE_AS_TEMPLATE_MESSAGES.nameRequired);

  // Modello d'origine (solo new_version): ne restano nome e descrizione, e i ruoli correnti fanno da `previous`
  let target: { id: number; name: string; description: string; previous: TemplateRole[] } | null = null;
  if (input.mode === "new_version") {
    if (instance.templateId === null) throw new InstanceError(409, SAVE_AS_TEMPLATE_MESSAGES.noTemplate);
    const row = await getTemplateRow(instance.templateId);
    if (row.archived) throw new TemplateError(409, TEMPLATE_MESSAGES.archived);
    target = { id: row.id, name: row.name, description: row.description, previous: await getTemplateVersion(row.id, row.version) };
  }

  // Promozioni: skill specializzate esistenti, codici validi, senza ripetizioni e liberi nel catalogo
  const local = await db.select().from(teamInstanceSkillsTable).where(eq(teamInstanceSkillsTable.instanceId, instanceId));
  const localByCode = new Map(local.map((s) => [s.code, s]));
  const promote = input.promote ?? [];
  const localCodes = new Set<string>();
  const newCodes = new Set<string>();
  for (const { localCode, code } of promote) {
    if (!localByCode.has(localCode)) throw new TeamRuleError(TEAM_MESSAGES.localSkillNotFound(localCode));
    if (!SKILL_CODE.test(code)) throw new SkillError(400, SKILL_MESSAGES.invalidCode);
    if (localCodes.has(localCode)) throw new TeamRuleError(SAVE_AS_TEMPLATE_MESSAGES.duplicatePromotion(localCode));
    if (newCodes.has(code)) throw new TeamRuleError(SAVE_AS_TEMPLATE_MESSAGES.duplicatePromotion(code));
    localCodes.add(localCode);
    newCodes.add(code);
  }
  if (newCodes.size > 0) {
    const taken = await db.select({ code: skillsTable.code }).from(skillsTable).where(inArray(skillsTable.code, [...newCodes]));
    if (taken.length > 0) throw new SkillError(409, SKILL_MESSAGES.duplicateCode);
  }
  const newCodeOf = new Map(promote.map((p) => [p.localCode, p.code]));

  // Ruoli del modello: skill del catalogo senza versione, specializzate promosse con il codice nuovo, le altre tolte
  const instanceRoles = InstanceRoleSchema.array().parse(instance.roles);
  const roles: TemplateRole[] = instanceRoles.map(({ localSkills, ...role }) => ({
    ...role,
    skills: [...role.skills.map((s) => s.code), ...localSkills.flatMap((code) => newCodeOf.get(code) ?? [])],
  }));

  // Validazione: le skill promosse non sono ancora nel catalogo, quindi si validano i ruoli senza di esse
  // e si controlla a parte che una skill solo-nodo non finisca in un ruolo cloud.
  await validateRoles({
    roles: roles.map((r) => ({ ...r, skills: r.skills.filter((code) => !newCodes.has(code)) })),
    mode: "template",
    userId,
    previous: target?.previous ?? null,
  });
  for (const role of roles) {
    if (role.runsOn !== "cloud") continue;
    for (const code of role.skills) {
      const origin = promote.find((p) => p.code === code);
      if (origin && localByCode.get(origin.localCode)!.kind === "node") {
        throw new TeamRuleError(TEAM_MESSAGES.skillNodeOnly(code));
      }
    }
  }

  const templateInput = { name: target?.name ?? name, description: target?.description, roles };
  const id = await db.transaction(async (tx) => {
    for (const { localCode, code } of promote) {
      const skill = localByCode.get(localCode)!;
      await createSkill({ code, name: skill.name, kind: skill.kind, content: skill.content, toolHints: skill.toolHints }, tx);
    }
    if (target) {
      const version = await appendTemplateVersionUnchecked(target.id, templateInput, tx);
      // L'istanza d'origine segue la nuova versione: usa ora le skill promosse dal catalogo (v1) al posto di
      // quelle specializzate, così non compaiono aggiornamenti che rimetterebbero la stessa skill due volte
      const promotedLocal = new Set(promote.map((p) => p.localCode));
      const relinked: InstanceRole[] = instanceRoles.map((role) => ({
        ...role,
        skills: [...role.skills, ...role.localSkills.flatMap((code) => (newCodeOf.has(code) ? [{ code: newCodeOf.get(code)!, version: 1 }] : []))],
        localSkills: role.localSkills.filter((code) => !promotedLocal.has(code)),
      }));
      if (promotedLocal.size > 0) {
        await tx
          .delete(teamInstanceSkillsTable)
          .where(and(eq(teamInstanceSkillsTable.instanceId, instanceId), inArray(teamInstanceSkillsTable.code, [...promotedLocal])));
      }
      await tx
        .update(teamInstancesTable)
        .set({ templateVersion: version, roles: relinked, updatedAt: new Date() })
        .where(eq(teamInstancesTable.id, instanceId));
      return target.id;
    }
    return insertTemplateUnchecked(templateInput, tx);
  });
  return getTemplate(id);
}
