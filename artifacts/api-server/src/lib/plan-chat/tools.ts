// Strumenti del bot della chat del piano (modulo puro: DB e lettura delle app arrivano da `PlanToolEnv`).
// `PlanToolRunner.run` restituisce sempre una stringa: gli errori del modello diventano testo da correggere.

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { z, type ZodIssue } from "zod";
import type { ChatToolCall } from "../ai/chat-types";
import { ITEM_SCHEMAS } from "../architect/schemas";
import { formatIssues } from "../architect/phase-loop";
import { MEMORY_TOOL_NAMES, runMemoryTool } from "../memory/tools";
import { PLAN_CHAPTERS, type PlanChapter } from "./context";

function fn(name: string, description: string, parameters: Record<string, unknown>): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

const EVIDENCE_HINT = "evidence (elenco di {source: code|openapi|mcp|description, location: testo, note?: testo})";

/** Campi del payload per capitolo, mostrati al modello nella descrizione di `propose` e negli errori. */
export const CHAPTER_FIELDS: Record<PlanChapter, string> = {
  endpoint:
    "title (testo), area (testo), method (testo, es. GET), path (testo), motivation (testo), patch (testo: modifica proposta all'app), " +
    EVIDENCE_HINT,
  completion:
    "key (testo, unica), phase (numero intero da 1), area (testo), title (testo), missing (testo: cosa manca oggi nel codice), " +
    `${EVIDENCE_HINT}, goal (testo), dependsOn (elenco di key di voci di completion), files (elenco di percorsi), effort (S|M|L), ` +
    "doneWhen (testo), implementation (testo)",
  evolution:
    "area (testo), type (best_practice|funzione|integrazione|agentica), title (testo), motivation (testo), " +
    `${EVIDENCE_HINT}, benefit (testo), impact (basso|medio|alto), effort (S|M|L), priority (numero intero da 1 a 5), implementation (testo)`,
};

const PAYLOAD_DESCRIPTION =
  "Voce nella forma del capitolo: con add tutti i campi, con update solo quelli da cambiare (gli altri restano quelli della voce). " +
  (Object.keys(CHAPTER_FIELDS) as PlanChapter[]).map((c) => `Campi di ${c}: ${CHAPTER_FIELDS[c]}.`).join(" ");

export const PLAN_TOOLS: ChatCompletionFunctionTool[] = [
  fn("read_item", "Legge il contenuto completo e le evidenze di una voce del piano, dato il suo riferimento.", {
    type: "object",
    properties: { ref: { type: "string", description: "Riferimento della voce, come nell'elenco del piano." } },
    required: ["ref"],
  }),
  fn("read_app", "Legge la scheda di un'altra app registrata in Botcave.", {
    type: "object",
    properties: { slug: { type: "string", description: "Slug dell'app." } },
    required: ["slug"],
  }),
  fn(
    "propose",
    "Propone una modifica al piano (aggiungere, modificare o scartare una voce). Non applica nulla: l'utente la vede come scheda e decide.",
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["add", "update", "discard"] },
        chapter: { type: "string", enum: PLAN_CHAPTERS },
        payload: { type: "object", description: PAYLOAD_DESCRIPTION },
        targetRef: { type: "string", description: "Riferimento della voce da modificare o scartare (update e discard)." },
        rationale: { type: "string", description: "Motivo della proposta, in poche frasi." },
      },
      required: ["kind", "chapter", "rationale"],
    },
  ),
];

export interface PlanToolItem {
  id: number;
  ref: string;
  chapter: PlanChapter;
  payload: unknown;
  status: string;
  evidence: unknown;
}

export interface NewProposal {
  kind: "add" | "update" | "discard";
  chapter: PlanChapter;
  payload: unknown | null;
  rationale: string;
  targetItemId: number | null;
  targetHash: string | null;
}

export interface PlanToolEnv {
  /** Solo voci endpoint/completion/evolution del piano, per ref. */
  items: Map<string, PlanToolItem>;
  /** Testo della scheda dell'app, null se non esiste. */
  readApp(slug: string): Promise<string | null>;
  saveProposal(p: NewProposal): Promise<number>;
  hash(item: PlanToolItem): string;
}

/** Correzioni ammesse per la stessa proposta (stessa voce): al tentativo successivo la proposta si abbandona. */
export const MAX_PROPOSE_CORRECTIONS = 2;
/** Proposte non valide ammesse in un turno, tra tutte le voci: oltre, nessuna proposta passa più. */
export const MAX_INVALID_PER_TURN = 8;
const RATIONALE_MAX = 1_000;
const EXHAUSTED = "correzioni esaurite: non proporre altro in questo turno";
export const PROPOSAL_EXHAUSTED = "correzioni esaurite per questa proposta: passa alla prossima o spiega all'utente cosa non va";

/** Errori di schema con il nome del campo tra virgolette (un campo può chiamarsi come una parola, es. «missing»). */
function formatPayloadIssues(issues: ZodIssue[]): string[] {
  return formatIssues(issues).map((line, i) => {
    const path = issues[i]?.path;
    if (!path?.length) return line;
    const where = path.join(".");
    return line.startsWith(`${where}: `) ? `campo "${where}": ${line.slice(where.length + 2)}` : line;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const ProposeArgs = z.object({
  kind: z.enum(["add", "update", "discard"], { message: "kind: deve essere add, update o discard" }),
  chapter: z.enum(PLAN_CHAPTERS as [PlanChapter, ...PlanChapter[]], { message: "chapter: deve essere endpoint, completion o evolution" }),
  payload: z.unknown().optional(),
  targetRef: z.string().optional(),
  rationale: z.string().trim().min(1, "rationale: non può essere vuota").max(RATIONALE_MAX, `rationale: massimo ${RATIONALE_MAX} caratteri`),
});

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class PlanToolRunner {
  /** Proposte non valide nel turno, tra tutte le voci. */
  private invalidTotal = 0;
  /** Correzioni per proposta (chiave: tipo, capitolo e voce). */
  private readonly corrections = new Map<string, number>();

  constructor(
    private readonly env: PlanToolEnv,
    private readonly userId: number,
  ) {}

  async run(call: ChatToolCall): Promise<string> {
    const args = parseArgs(call.arguments);
    if ((MEMORY_TOOL_NAMES as readonly string[]).includes(call.name)) return this.memory(call.name, args);
    if (!args) return call.name === "propose" ? this.invalid("?", ["argomenti: JSON non valido"]) : "argomenti non validi: serve un oggetto JSON";
    switch (call.name) {
      case "read_item": {
        const ref = typeof args.ref === "string" ? args.ref : "";
        const item = this.env.items.get(ref);
        return item ? JSON.stringify({ payload: item.payload, evidence: item.evidence }) : `voce non trovata: ${ref}`;
      }
      case "read_app": {
        const slug = typeof args.slug === "string" ? args.slug : "";
        return (await this.env.readApp(slug)) ?? `app non trovata: ${slug}`;
      }
      case "propose":
        return this.propose(args);
      default:
        return `strumento sconosciuto: ${call.name}`;
    }
  }

  /** Strumenti di memoria di Lucius: l'esito è sempre testo, anche se lo strumento lancia. */
  private async memory(name: string, args: Record<string, unknown> | null): Promise<string> {
    if (!args) return "argomenti non validi: serve un oggetto JSON";
    try {
      const r = await runMemoryTool(this.userId, "lucius", name, args);
      return JSON.stringify(r.ok ? r.result : { error: r.error });
    } catch {
      return "errore interno dello strumento";
    }
  }

  private invalid(key: string, problems: string[]): string {
    this.invalidTotal += 1;
    if (this.invalidTotal > MAX_INVALID_PER_TURN) return EXHAUSTED;
    const n = (this.corrections.get(key) ?? 0) + 1;
    this.corrections.set(key, n);
    if (n > MAX_PROPOSE_CORRECTIONS) return PROPOSAL_EXHAUSTED;
    return "proposta non valida:\n" + problems.join("\n");
  }

  /** Stessa proposta = stesso tipo, capitolo e voce (targetRef, oppure key o titolo del payload). */
  private proposalKey(args: Record<string, unknown>): string {
    const payload = isPlainObject(args.payload) ? args.payload : {};
    const ref = typeof args.targetRef === "string" ? args.targetRef : String(payload.key ?? payload.title ?? "");
    return `${String(args.kind)}|${String(args.chapter)}|${ref}`;
  }

  private async propose(args: Record<string, unknown>): Promise<string> {
    // Troppe proposte non valide nel turno: nessuna proposta passa più, nemmeno se valida
    if (this.invalidTotal >= MAX_INVALID_PER_TURN) return EXHAUSTED;
    const key = this.proposalKey(args);
    if ((this.corrections.get(key) ?? 0) > MAX_PROPOSE_CORRECTIONS) return PROPOSAL_EXHAUSTED;
    const parsed = ProposeArgs.safeParse(args);
    if (!parsed.success) return this.invalid(key, formatIssues(parsed.error.issues));
    const { kind, chapter, payload, targetRef, rationale } = parsed.data;

    let target: PlanToolItem | null = null;
    if (kind !== "add") {
      target = (targetRef && this.env.items.get(targetRef)) || null;
      if (!target || target.chapter !== chapter) {
        return this.invalid(key, [`targetRef: voce "${targetRef ?? ""}" non trovata nel capitolo ${chapter}`]);
      }
    }

    let valid: unknown = null;
    if (kind !== "discard") {
      // Con update bastano i campi da cambiare: gli altri restano quelli della voce
      const full = kind === "update" && isPlainObject(target?.payload) && isPlainObject(payload) ? { ...target.payload, ...payload } : payload;
      const r = ITEM_SCHEMAS[chapter].safeParse(full);
      if (!r.success) return this.invalid(key, [...formatPayloadIssues(r.error.issues), `Campi di ${chapter}: ${CHAPTER_FIELDS[chapter]}.`]);
      valid = r.data;
      if (chapter === "completion") {
        const problems = this.checkDependencies(valid as { key: string; dependsOn: string[] });
        if (problems.length) return this.invalid(key, problems);
      }
    }

    const id = await this.env.saveProposal({
      kind,
      chapter,
      payload: valid,
      rationale: rationale.trim(),
      targetItemId: target?.id ?? null,
      targetHash: target ? this.env.hash(target) : null,
    });
    return `proposta registrata (#${id}): l'utente la vedrà come scheda`;
  }

  /** Ogni dipendenza è la key di una voce di completamento del piano o la key della voce stessa. */
  private checkDependencies(payload: { key: string; dependsOn: string[] }): string[] {
    const keys = new Set<string>([payload.key]);
    for (const it of this.env.items.values()) {
      if (it.chapter !== "completion") continue;
      const k = (it.payload as { key?: unknown } | null)?.key;
      if (typeof k === "string") keys.add(k);
    }
    return payload.dependsOn.filter((d) => !keys.has(d)).map((d) => `dependsOn: "${d}" non è la key di una voce di completamento del piano`);
  }
}
