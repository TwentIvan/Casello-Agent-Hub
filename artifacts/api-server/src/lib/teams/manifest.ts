import { z } from "zod";
import { SKILL_CODE } from "./skills";

// Manifesto di un ruolo di squadra. Nel modello le skill sono codici (senza versione); nell'istanza sono
// fissate a una versione e possono esserci skill specializzate (`localSkills`, codici locali all'istanza).
// I limiti sul numero di ruoli e di skill si controllano in `rules.ts`, con messaggio proprio.

export const RoleKey = /^[a-z0-9_-]{1,40}$/;
export const MAX_ROLES = 20;
export const MAX_SKILLS_PER_ROLE = 30;
export const MAX_TASK = 8000;

const noRepeats = <T>(items: T[], keyOf: (item: T) => string): boolean =>
  new Set(items.map(keyOf)).size === items.length;

const skillCode = z.string().regex(SKILL_CODE);

export const ROLE_CODES = ["none", "read", "write"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

const baseRole = {
  key: z.string().regex(RoleKey),
  name: z.string().min(1).max(80),
  task: z.string().max(MAX_TASK),
  isLead: z.boolean(),
  runsOn: z.enum(["cloud", "node"]),
  aiModelId: z.number().int().nullable(),
  // Accesso al codice dell'App di riferimento: assente = nessuno (i manifesti già salvati restano validi)
  code: z.enum(ROLE_CODES).default("none"),
  tools: z.array(z.number().int()).refine((ids) => noRepeats(ids, String), { message: "strumenti ripetuti" }),
};

export const TemplateRoleSchema = z.object({
  ...baseRole,
  skills: z.array(skillCode).refine((codes) => noRepeats(codes, (c) => c), { message: "skill ripetute" }),
});

export const InstanceRoleSchema = z.object({
  ...baseRole,
  skills: z
    .array(z.object({ code: skillCode, version: z.number().int().min(1) }))
    .refine((items) => noRepeats(items, (s) => s.code), { message: "skill ripetute" }),
  localSkills: z.array(skillCode).refine((codes) => noRepeats(codes, (c) => c), { message: "skill ripetute" }),
});

export type TemplateRole = z.infer<typeof TemplateRoleSchema>;
export type InstanceRole = z.infer<typeof InstanceRoleSchema>;
