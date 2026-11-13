import type { Character, ChatTarget, SubjectType } from "./adapters";

// Parti pure dei bersagli del pannello: solo import di tipi, così si provano con Vitest in ambiente node.

export function targetKey(target: ChatTarget): string {
  switch (target.kind) {
    case "alfred":
      return "alfred";
    case "character":
      return `character:${target.subjectType}:${target.subjectId ?? ""}`;
    case "plan":
      return `plan:${target.appId}`;
    case "team":
      return `team:${target.instanceId}`;
    case "lead":
      return "lead";
  }
}

/** Nome e testi del campo di scrittura per personaggio. */
export const CHARACTER_TEXT: Record<Character, { name: string; placeholder: string; send: string }> = {
  alfred: { name: "Alfred", placeholder: "Scrivi ad Alfred…", send: "Scrivi ad Alfred" },
  lucius: { name: "Lucius", placeholder: "Scrivi a Lucius…", send: "Scrivi a Lucius" },
  responsabile: { name: "Responsabile", placeholder: "Scrivi al Responsabile…", send: "Scrivi al Responsabile" },
};

export const SUBJECT_LABELS: Record<Exclude<SubjectType, "alfred_thread">, string> = {
  agent: "Agente",
  skill: "Skill",
  team_template: "Modello di squadra",
  area_agents: "Area Agenti",
  area_skills: "Area Skill",
  area_team_templates: "Area Modelli di squadra",
};
