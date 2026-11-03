import type {
  SkillKind,
  TeamInstanceRole,
  TeamRole,
  TeamRoleRunsOn,
  TeamRoleView,
  ToolLevel,
} from "@workspace/api-client-react";

/** Strumento di un ruolo nell'editor: quanto basta per mostrarlo come app · nome · livello. */
export interface ToolRef {
  id: number;
  appName?: string;
  name: string;
  level?: ToolLevel;
  available: boolean;
}

/** Skill del catalogo in un ruolo; `version` solo nelle squadre (skill fissata a una versione). */
export interface SkillRef {
  code: string;
  name: string;
  kind: SkillKind;
  deprecated: boolean;
  version?: number;
}

/** Ruolo in modifica, comune a modelli e squadre. */
export interface RoleDraft {
  /** Identificativo locale per React (la `key` di un ruolo nuovo nasce solo al salvataggio). */
  uid: string;
  /** Vuota finché il ruolo non è stato salvato. */
  key: string;
  name: string;
  task: string;
  isLead: boolean;
  runsOn: TeamRoleRunsOn;
  aiModelId: number | null;
  tools: ToolRef[];
  skills: SkillRef[];
  /** Codici delle skill specializzate della squadra (vuoto nei modelli). */
  localSkills: string[];
}

export const RUNS_ON_LABELS: Record<TeamRoleRunsOn, string> = {
  cloud: "Cloud",
  node: "Nodo locale",
};

const KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

/** Chiave stabile del ruolo dal nome (minuscole, senza accenti, `-` al posto degli spazi), unica nella squadra. */
export function roleKeyFromName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "ruolo";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate) && KEY_PATTERN.test(candidate)) return candidate;
  }
}

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `r${uidCounter}`;
}

export function draftFromView(role: TeamRoleView): RoleDraft {
  return {
    uid: nextUid(),
    key: role.key,
    name: role.name,
    task: role.task,
    isLead: role.isLead,
    runsOn: role.runsOn,
    aiModelId: role.model?.id ?? null,
    tools: role.tools.map((t) => ({ id: t.id, appName: t.appName, name: t.name, level: t.level, available: t.available })),
    skills: role.skills
      .filter((s) => !s.local)
      .map((s) => ({ code: s.code, name: s.name, kind: s.kind, deprecated: s.deprecated, version: s.version })),
    localSkills: role.skills.filter((s) => s.local).map((s) => s.code),
  };
}

/** Un ruolo `node` non ha modello: il valore si scarta qui, così cambiare luogo e tornare indietro non lo perde. */
function modelOf(role: RoleDraft): number | null {
  return role.runsOn === "cloud" ? role.aiModelId : null;
}

export function toTemplateRole(role: RoleDraft): TeamRole {
  return {
    key: role.key,
    name: role.name.trim(),
    task: role.task,
    isLead: role.isLead,
    runsOn: role.runsOn,
    aiModelId: modelOf(role),
    tools: role.tools.map((t) => t.id),
    skills: role.skills.map((s) => s.code),
  };
}

export function toInstanceRole(role: RoleDraft): TeamInstanceRole {
  return {
    ...toTemplateRole(role),
    // Una skill aggiunta nell'istanza ha sempre la versione corrente del catalogo (presa al momento della scelta)
    skills: role.skills.map((s) => ({ code: s.code, version: s.version ?? 1 })),
    localSkills: role.localSkills,
  };
}

/** Ruolo vuoto per «Aggiungi ruolo»: capo solo se è il primo. */
export function newRole(existing: RoleDraft[]): RoleDraft {
  const name = `Ruolo ${existing.length + 1}`;
  return {
    uid: nextUid(),
    key: "",
    name,
    task: "",
    isLead: existing.length === 0,
    runsOn: "cloud",
    aiModelId: null,
    tools: [],
    skills: [],
    localSkills: [],
  };
}

/**
 * Chiavi per i ruoli nuovi (key vuota), generate dal nome al salvataggio: dopo la creazione la chiave non cambia
 * più, così il ruolo resta riconoscibile tra le versioni anche se lo si rinomina.
 */
export function withKeys(roles: RoleDraft[]): RoleDraft[] {
  const taken = new Set(roles.map((r) => r.key).filter(Boolean));
  return roles.map((r) => {
    if (r.key) return r;
    const key = roleKeyFromName(r.name, taken);
    taken.add(key);
    return { ...r, key };
  });
}
