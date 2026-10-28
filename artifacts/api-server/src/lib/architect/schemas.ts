import { z, type ZodType } from "zod";
import type { analysisChapterEnum } from "@workspace/db";
import { checkParamsSchema, checkPathPlaceholders, parseDefinition } from "../tools/definition";
import type { HttpDefinition } from "../tools/types";

// Schemi Zod degli esiti delle fasi dell'architetto e dei singoli elementi della proposta.
// I messaggi sono in italiano: tornano al modello come richiesta di correzione.

export const PHASES = ["map", "capabilities", "catalog", "agents", "completion", "evolution"] as const;
export type PhaseName = (typeof PHASES)[number];

/** Capitolo di un elemento della proposta (stessi valori dell'enum del DB e dell'OpenAPI). */
export type AnalysisChapter = (typeof analysisChapterEnum.enumValues)[number];

// Limiti contro l'esito gonfiato del modello
const SHORT = 2_000;
const LONG = 20_000;
const MAX_ITEMS = 100;
const MAX_TOOLS = 200;
const MAX_LIST = 200;

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const TOOL_NAME_MSG = "nome non valido: da 1 a 64 caratteri tra lettere, cifre, '_' e '-'";

const TYPE_IT: Record<string, string> = {
  string: "una stringa",
  number: "un numero",
  integer: "un numero intero",
  boolean: "un booleano",
  array: "un elenco",
  object: "un oggetto",
};

// Mappa degli errori in italiano per i casi senza messaggio esplicito
const itMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case "invalid_type":
      return {
        message:
          issue.received === "undefined"
            ? "campo obbligatorio"
            : `deve essere ${TYPE_IT[issue.expected] ?? issue.expected}`,
      };
    case "invalid_enum_value":
      return { message: `valore non ammesso (valori ammessi: ${issue.options.join(", ")})` };
    case "too_small":
      if (issue.type === "string") return { message: "non può essere vuoto" };
      if (issue.type === "array") return { message: `servono almeno ${String(issue.minimum)} elementi` };
      return { message: `deve essere almeno ${String(issue.minimum)}` };
    case "too_big":
      if (issue.type === "string") return { message: `testo troppo lungo (massimo ${String(issue.maximum)} caratteri)` };
      if (issue.type === "array") return { message: `troppi elementi (massimo ${String(issue.maximum)})` };
      return { message: `deve essere al massimo ${String(issue.maximum)}` };
    case "invalid_literal":
      return { message: `valore non ammesso (atteso ${JSON.stringify(issue.expected)})` };
    case "invalid_union":
      return { message: "valore non valido" };
    default:
      return { message: ctx.defaultError === "Required" ? "campo obbligatorio" : "valore non valido" };
  }
};
const P = { errorMap: itMap };

/** Appunti scritti dal modello per le fasi successive: finiscono nel dossier di previousBlock. */
export const NOTES_MAX_CHARS = 6_000;

const str = (max = SHORT) => z.string(P).max(max, `testo troppo lungo (massimo ${max} caratteri)`);
const notes = () => str(NOTES_MAX_CHARS).optional();
const nonEmpty = (max = SHORT) => str(max).min(1, "non può essere vuoto");
const bool = () => z.boolean(P);
const list = <T extends ZodType>(item: T, max = MAX_LIST) => z.array(item, P).max(max, `troppi elementi (massimo ${max})`);
const en = <const V extends [string, ...string[]]>(values: V) => z.enum(values, P);
const obj = <S extends z.ZodRawShape>(shape: S) => z.object(shape, P);

export const EvidenceSchema = obj({
  source: en(["code", "openapi", "description"]),
  location: nonEmpty(),
  note: str().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
const evidenceList = () => list(EvidenceSchema, 20);

const identity = () => en(["user", "service"]);
const effort = () => en(["S", "M", "L"]);
const jsonObject = () => z.record(z.string(), z.unknown(), P);

// --- Fase 1: mappa ---

export const MapResultSchema = obj({
  stack: list(nonEmpty(200), 50),
  structure: str(LONG),
  routes: list(obj({ method: nonEmpty(20), path: nonEmpty(), file: str().optional() }), MAX_TOOLS),
  dataModels: list(obj({ name: nonEmpty(), file: str().optional(), fields: list(nonEmpty(200), 100) }), MAX_ITEMS),
  auth: obj({ mechanism: str(LONG), userToken: str(LONG), notes: str(LONG).optional() }),
  uiAreas: list(obj({ name: nonEmpty(), description: str(), pages: list(nonEmpty(), 50) }), MAX_ITEMS),
  summary: str(LONG),
  notes: notes(),
});

// --- Fase 2: capacità ---

export const CapabilitiesResultSchema = obj({
  areas: list(
    obj({
      area: nonEmpty(),
      capabilities: list(
        obj({ name: nonEmpty(), description: str(), endpoints: list(nonEmpty(), 50), evidence: evidenceList() }),
        MAX_ITEMS,
      ),
    }),
    MAX_ITEMS,
  ),
  notes: notes(),
});

// --- Fase 3: catalogo ---

export const ToolProposalSchema = obj({
  name: str(64).regex(TOOL_NAME, TOOL_NAME_MSG),
  description: str(),
  kind: z.literal("http", { errorMap: () => ({ message: "nella fase 1 sono ammessi solo tool di tipo http" }) }),
  identity: identity(),
  requiresConfirmation: bool(),
  readOnly: bool(),
  paramsSchema: jsonObject(),
  definition: jsonObject(),
  area: nonEmpty(),
  evidence: evidenceList(),
  needsVerification: bool(),
}).superRefine((tool, ctx) => {
  // Stesse regole del salvataggio di un tool: una proposta non applicabile fallisce qui
  const parsed = parseDefinition("http", tool.definition);
  if (!parsed.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["definition"], message: parsed.error });
    return;
  }
  const schemaError = checkParamsSchema(tool.paramsSchema);
  if (schemaError) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paramsSchema"], message: schemaError });
    return;
  }
  const placeholderError = checkPathPlaceholders(parsed.value as HttpDefinition, tool.paramsSchema);
  if (placeholderError) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paramsSchema"], message: placeholderError });
  }
});

export const EndpointProposalSchema = obj({
  title: nonEmpty(),
  area: nonEmpty(),
  method: nonEmpty(20),
  path: nonEmpty(),
  motivation: str(LONG),
  patch: str(LONG),
  evidence: evidenceList(),
});

/** Segnala i valori ripetuti: i riferimenti degli elementi devono essere unici nell'analisi. */
function addDuplicates(ctx: z.RefinementCtx, keys: string[], path: (string | number)[], what: (k: string) => string) {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const key of keys) {
    if (seen.has(key) && !reported.has(key)) {
      reported.add(key);
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: what(key) });
    }
    seen.add(key);
  }
}

export const CatalogResultSchema = obj({
  tools: list(ToolProposalSchema, MAX_TOOLS),
  endpoints: list(EndpointProposalSchema, MAX_ITEMS),
  notes: notes(),
}).superRefine((res, ctx) => {
  addDuplicates(ctx, res.tools.map((t) => t.name), ["tools"], (k) => `il tool "${k}" è proposto più volte: i nomi devono essere unici`);
  addDuplicates(
    ctx,
    res.endpoints.map((e) => `${e.method.trim().toUpperCase()} ${e.path.trim()}`),
    ["endpoints"],
    (k) => `l'endpoint "${k}" è proposto più volte: metodo e percorso devono essere unici`,
  );
});

// --- Fase 4: agenti e skill ---

const role = () => en(["general", "area"]);

/** Coerenza ruolo/area: `general` senza area, `area` con un'area non vuota. */
function checkRoleArea(value: { role: string; area: string | null }, ctx: z.RefinementCtx, path: string) {
  if (value.role === "general" && value.area !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "l'agente generale non ha un'area: deve essere null" });
  }
  if (value.role === "area" && (value.area === null || value.area.trim() === "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "un agente di area richiede il nome dell'area" });
  }
}

export const AgentProposalSchema = obj({
  role: role(),
  area: str().nullable(),
  name: nonEmpty(),
  systemPrompt: str(LONG),
  defaultIdentity: identity(),
  toolNames: list(nonEmpty(64), MAX_TOOLS),
}).superRefine((agent, ctx) => checkRoleArea(agent, ctx, "area"));

export const SkillProposalSchema = obj({
  agentRole: role(),
  agentArea: str().nullable(),
  name: nonEmpty(),
  description: str(),
  instructions: str(LONG),
  toolNames: list(nonEmpty(64), MAX_TOOLS),
  paramsSchema: jsonObject().nullable(),
}).superRefine((skill, ctx) => checkRoleArea({ role: skill.agentRole, area: skill.agentArea }, ctx, "agentArea"));

/**
 * Chiave di una skill per (agente, nome), condivisa dal controllo dei duplicati e dal riferimento
 * dell'elemento (`skillRef`): area senza spazi ai bordi e componenti codificati, così il separatore
 * ":" non è ambiguo (area "a:b" + nome "c" ≠ area "a" + nome "b:c").
 */
export function skillKey(role: string, area: string | null, name: string): string {
  const agent = role === "general" ? "general" : `area:${encodeURIComponent((area ?? "").trim())}`;
  return `${agent}:${encodeURIComponent(name)}`;
}

export const AgentsResultSchema = obj({
  agents: list(AgentProposalSchema, MAX_ITEMS),
  skills: list(SkillProposalSchema, MAX_ITEMS),
  notes: notes(),
}).superRefine((res, ctx) => {
  const generals = res.agents.filter((a) => a.role === "general").length;
  if (generals !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agents"],
      message: `serve esattamente un agente generale (trovati ${generals})`,
    });
  }
  addDuplicates(
    ctx,
    res.agents.filter((a) => a.role === "area").map((a) => (a.area ?? "").trim()),
    ["agents"],
    (k) => `l'area "${k}" ha più di un agente: ogni area ne vuole uno solo`,
  );
  // Il messaggio mostra agente e nome in chiaro, non la chiave codificata
  const skillLabels = new Map(
    res.skills.map((sk) => [
      skillKey(sk.agentRole, sk.agentArea, sk.name),
      `${sk.agentRole === "general" ? "general" : (sk.agentArea ?? "").trim()}/${sk.name}`,
    ]),
  );
  addDuplicates(
    ctx,
    res.skills.map((sk) => skillKey(sk.agentRole, sk.agentArea, sk.name)),
    ["skills"],
    (k) => `la skill "${skillLabels.get(k) ?? k}" è proposta più volte: (agente, nome) devono essere unici`,
  );
});

// --- Fase 5: completamento ---

export const CompletionItemSchema = obj({
  key: nonEmpty(100),
  phase: z.number(P).int("deve essere un numero intero").min(1, "la fase parte da 1").max(100),
  area: nonEmpty(),
  title: nonEmpty(),
  missing: str(LONG),
  evidence: evidenceList(),
  goal: str(LONG),
  dependsOn: list(nonEmpty(100), MAX_ITEMS),
  files: list(nonEmpty(), 100),
  effort: effort(),
  doneWhen: str(LONG),
  implementation: str(LONG),
});

export const CompletionResultSchema = obj({ items: list(CompletionItemSchema, MAX_ITEMS), notes: notes() }).superRefine((res, ctx) => {
  const keys = new Set(res.items.map((i) => i.key));
  if (keys.size !== res.items.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "le chiavi delle voci devono essere uniche" });
    return;
  }
  const phaseOf = new Map(res.items.map((i) => [i.key, i.phase]));
  res.items.forEach((item, index) => {
    for (const dep of item.dependsOn) {
      const depPhase = phaseOf.get(dep);
      if (depPhase === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "dependsOn"],
          message: `la dipendenza "${dep}" non corrisponde a nessuna voce`,
        });
      } else if (depPhase > item.phase) {
        // Il piano si completa per fasi: una dipendenza non può arrivare in una fase successiva
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "dependsOn"],
          message: `la voce "${item.key}" (fase ${item.phase}) dipende da "${dep}" che è in una fase successiva (${depPhase}): la dipendenza deve stare nella stessa fase o in una precedente`,
        });
      }
    }
  });
  // Ricerca di cicli con visita in profondità (solo se le chiavi sono tutte valide)
  if (res.items.every((i) => i.dependsOn.every((d) => keys.has(d)))) {
    const deps = new Map(res.items.map((i) => [i.key, i.dependsOn]));
    const state = new Map<string, 1 | 2>();
    const visit = (key: string): boolean => {
      if (state.get(key) === 2) return false;
      if (state.get(key) === 1) return true;
      state.set(key, 1);
      for (const d of deps.get(key) ?? []) if (visit(d)) return true;
      state.set(key, 2);
      return false;
    };
    if (res.items.some((i) => visit(i.key))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "le dipendenze contengono un ciclo: ogni voce deve poter essere ordinata dopo le sue dipendenze",
      });
    }
  }
});

// --- Fase 6: evoluzione ---

export const EvolutionItemSchema = obj({
  area: nonEmpty(),
  type: en(["best_practice", "funzione", "integrazione", "agentica"]),
  title: nonEmpty(),
  motivation: str(LONG),
  evidence: evidenceList(),
  benefit: str(LONG),
  impact: en(["basso", "medio", "alto"]),
  effort: effort(),
  priority: z.number(P).int("deve essere un numero intero").min(1, "la priorità va da 1 a 5").max(5, "la priorità va da 1 a 5"),
  implementation: str(LONG),
});

export const EvolutionResultSchema = obj({ items: list(EvolutionItemSchema, MAX_ITEMS), notes: notes() });

export const PHASE_SCHEMAS: Record<PhaseName, ZodType> = {
  map: MapResultSchema,
  capabilities: CapabilitiesResultSchema,
  catalog: CatalogResultSchema,
  agents: AgentsResultSchema,
  completion: CompletionResultSchema,
  evolution: EvolutionResultSchema,
};

/** Schema del payload di un elemento della proposta, per capitolo (usato nella modifica in revisione). */
export const ITEM_SCHEMAS: Record<AnalysisChapter, ZodType> = {
  tool: ToolProposalSchema,
  endpoint: EndpointProposalSchema,
  agent: AgentProposalSchema,
  skill: SkillProposalSchema,
  completion: CompletionItemSchema,
  evolution: EvolutionItemSchema,
};

export type MapResult = z.infer<typeof MapResultSchema>;
export type CapabilitiesResult = z.infer<typeof CapabilitiesResultSchema>;
export type CatalogResult = z.infer<typeof CatalogResultSchema>;
export type AgentsResult = z.infer<typeof AgentsResultSchema>;
export type CompletionResult = z.infer<typeof CompletionResultSchema>;
export type EvolutionResult = z.infer<typeof EvolutionResultSchema>;

export type ToolProposal = z.infer<typeof ToolProposalSchema>;
export type EndpointProposal = z.infer<typeof EndpointProposalSchema>;
export type AgentProposal = z.infer<typeof AgentProposalSchema>;
export type SkillProposal = z.infer<typeof SkillProposalSchema>;
export type CompletionItem = z.infer<typeof CompletionItemSchema>;
export type EvolutionItem = z.infer<typeof EvolutionItemSchema>;
