import { inArray } from "drizzle-orm";
import { db, appToolsTable, skillsTable, skillVersionsTable } from "@workspace/db";
import { effectiveLevel } from "../tools/levels";
import { ModelChoiceError, MODEL_UNAVAILABLE, chooseOwnModel } from "../ai/choice";
import {
  InstanceRoleSchema,
  MAX_ROLES,
  MAX_SKILLS_PER_ROLE,
  TemplateRoleSchema,
  type InstanceRole,
  type TemplateRole,
} from "./manifest";
import type { SkillKind } from "./skills";

// Regole applicate a ogni salvataggio di un modello o di un'istanza di squadra (spec §3). Si lancia
// `TeamRuleError` (400) alla prima violazione; le letture dal DB sono a lotti, non per elemento.

export const TEAM_MESSAGES = {
  oneLead: "una squadra ha esattamente un capo",
  modelUnavailable: MODEL_UNAVAILABLE,
  teamClosed: "squadra chiusa",
  duplicateName: "ruoli con lo stesso nome",
  duplicateKey: "ruoli con la stessa chiave",
  tooManyRoles: "troppi ruoli",
  invalidRoles: "ruoli non validi",
  repeatedTools: (role: string) => `strumenti ripetuti nel ruolo ${role}`,
  repeatedSkills: (role: string) => `skill ripetute nel ruolo ${role}`,
  tooManySkills: (role: string) => `troppe skill nel ruolo ${role}`,
  skillNotFound: (code: string) => `skill ${code} inesistente`,
  skillDeprecated: (code: string) => `skill ${code} deprecata`,
  skillVersionNotFound: (version: number, code: string) => `versione ${version} della skill ${code} inesistente`,
  localSkillNotFound: (code: string) => `skill specializzata ${code} inesistente`,
  skillNodeOnly: (code: string) => `la skill ${code} gira solo sul nodo locale`,
  toolNotUsable: (name: string) => `lo strumento ${name} non può essere usato da una squadra`,
  nodeRoleHasModel: "un ruolo sul nodo non ha un modello cloud",
} as const;

export class TeamRuleError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "TeamRuleError";
  }
}

type Role = TemplateRole | InstanceRole;

export interface ValidateRolesInput {
  roles: Role[];
  mode: "template" | "instance";
  userId: number;
  /** Ruoli della versione precedente (per `key`): ammettono skill deprecate e strumenti non più usabili già presenti. */
  previous: Role[] | null;
  /** Solo istanze: skill specializzate dell'istanza, per codice, con il loro tipo. */
  localSkillCodes?: Map<string, SkillKind>;
}

const skillCodesOf = (role: Role): string[] =>
  role.skills.map((s) => (typeof s === "string" ? s : s.code));

const localCodesOf = (role: Role): string[] => ("localSkills" in role ? role.localSkills : []);

function fail(message: string): never {
  throw new TeamRuleError(message);
}

export async function validateRoles(input: ValidateRolesInput): Promise<void> {
  const { roles, mode, userId, previous, localSkillCodes } = input;

  // Forma del manifesto: è la stessa che si rilegge a ogni lettura, quindi un ruolo che non la rispetta
  // (es. strumenti o skill ripetuti) non deve mai essere salvato
  const shape = (mode === "template" ? TemplateRoleSchema : InstanceRoleSchema).array().safeParse(roles);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    const role = issue && typeof issue.path[0] === "number" ? roles[issue.path[0]] : undefined;
    const field = issue?.path[1];
    if (role && issue?.message === "strumenti ripetuti") fail(TEAM_MESSAGES.repeatedTools(role.name));
    if (role && issue?.message === "skill ripetute" && (field === "skills" || field === "localSkills")) {
      fail(TEAM_MESSAGES.repeatedSkills(role.name));
    }
    fail(TEAM_MESSAGES.invalidRoles);
  }

  // Struttura: capo, numero di ruoli, chiavi e nomi unici, numero di skill
  if (roles.filter((r) => r.isLead).length !== 1) fail(TEAM_MESSAGES.oneLead);
  if (roles.length < 1 || roles.length > MAX_ROLES) fail(TEAM_MESSAGES.tooManyRoles);
  if (new Set(roles.map((r) => r.key)).size !== roles.length) fail(TEAM_MESSAGES.duplicateKey);
  if (new Set(roles.map((r) => r.name)).size !== roles.length) fail(TEAM_MESSAGES.duplicateName);
  for (const role of roles) {
    if (skillCodesOf(role).length + localCodesOf(role).length > MAX_SKILLS_PER_ROLE) {
      fail(TEAM_MESSAGES.tooManySkills(role.name));
    }
  }

  // Luogo e modello
  const checkedModels = new Set<number>();
  for (const role of roles) {
    if (role.runsOn === "node") {
      if (role.aiModelId !== null) fail(TEAM_MESSAGES.nodeRoleHasModel);
      continue;
    }
    if (role.aiModelId === null) fail(TEAM_MESSAGES.modelUnavailable);
    if (checkedModels.has(role.aiModelId)) continue;
    try {
      await chooseOwnModel(role.aiModelId, userId);
    } catch (err) {
      if (err instanceof ModelChoiceError) fail(TEAM_MESSAGES.modelUnavailable);
      throw err;
    }
    checkedModels.add(role.aiModelId);
  }

  // Skill del catalogo: una sola lettura per tutti i codici
  const codes = [...new Set(roles.flatMap(skillCodesOf))];
  const skills = codes.length > 0 ? await db.select().from(skillsTable).where(inArray(skillsTable.code, codes)) : [];
  const skillByCode = new Map(skills.map((s) => [s.code, s]));

  for (const role of roles) {
    if (role.runsOn === "node") continue;
    for (const code of skillCodesOf(role)) {
      if (skillByCode.get(code)?.kind === "node") fail(TEAM_MESSAGES.skillNodeOnly(code));
    }
  }
  const previousByKey = new Map((previous ?? []).map((r) => [r.key, r]));
  for (const role of roles) {
    const before = previousByKey.get(role.key);
    const beforeCodes = new Set(before ? skillCodesOf(before) : []);
    for (const code of skillCodesOf(role)) {
      const skill = skillByCode.get(code);
      if (!skill) fail(TEAM_MESSAGES.skillNotFound(code));
      if (skill.deprecated && !beforeCodes.has(code)) fail(TEAM_MESSAGES.skillDeprecated(code));
    }
  }

  // Istanze: versioni fissate esistenti e skill specializzate
  if (mode === "instance") {
    const ids = [...new Set(skills.map((s) => s.id))];
    const versions =
      ids.length > 0 ? await db.select().from(skillVersionsTable).where(inArray(skillVersionsTable.skillId, ids)) : [];
    const existing = new Set(versions.map((v) => `${v.skillId}:${v.version}`));
    for (const role of roles) {
      for (const item of role.skills) {
        if (typeof item === "string") continue;
        const skill = skillByCode.get(item.code)!;
        if (!existing.has(`${skill.id}:${item.version}`)) {
          fail(TEAM_MESSAGES.skillVersionNotFound(item.version, item.code));
        }
      }
    }
    for (const role of roles) {
      for (const code of localCodesOf(role)) {
        const kind = localSkillCodes?.get(code);
        if (kind === undefined) fail(TEAM_MESSAGES.localSkillNotFound(code));
        if (kind === "node" && role.runsOn === "cloud") fail(TEAM_MESSAGES.skillNodeOnly(code));
      }
    }
  }

  // Strumenti: una sola lettura per tutti gli id
  const toolIds = [...new Set(roles.flatMap((r) => r.tools))];
  const tools = toolIds.length > 0 ? await db.select().from(appToolsTable).where(inArray(appToolsTable.id, toolIds)) : [];
  const toolById = new Map(tools.map((t) => [t.id, t]));
  for (const role of roles) {
    const beforeTools = new Set(previousByKey.get(role.key)?.tools ?? []);
    for (const id of role.tools) {
      if (beforeTools.has(id)) continue;
      const tool = toolById.get(id);
      if (!tool || tool.status !== "active" || effectiveLevel(tool) === "L3") {
        fail(TEAM_MESSAGES.toolNotUsable(tool?.name ?? `#${id}`));
      }
    }
  }
}
