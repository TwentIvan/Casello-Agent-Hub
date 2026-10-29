// Strumenti del bot della chat del piano (modulo puro: DB e lettura delle app arrivano da `PlanToolEnv`).
// `PlanToolRunner.run` restituisce sempre una stringa: gli errori del modello diventano testo da correggere.

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { ChatToolCall } from "../ai-gateway";
import { ITEM_SCHEMAS } from "../architect/schemas";
import { formatIssues } from "../architect/phase-loop";
import { PLAN_CHAPTERS, type PlanChapter } from "./context";

function fn(name: string, description: string, parameters: Record<string, unknown>): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

export const PLAN_TOOLS: ChatCompletionFunctionTool[] = [
  fn("read_item", "Legge il contenuto completo e le evidenze di una voce del piano, dato il suo riferimento.", {
    type: "object",
    properties: { ref: { type: "string", description: "Riferimento della voce, come nell'elenco del piano." } },
    required: ["ref"],
  }),
  fn("read_app", "Legge la scheda di un'altra app registrata in Casello.", {
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
        payload: { type: "object", description: "Voce completa nella forma del capitolo (add e update)." },
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

export const MAX_PROPOSE_CORRECTIONS = 2;
const RATIONALE_MAX = 1_000;
const EXHAUSTED = "correzioni esaurite: non proporre altro in questo turno";

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
  private corrections = 0;

  constructor(private readonly env: PlanToolEnv) {}

  async run(call: ChatToolCall): Promise<string> {
    const args = parseArgs(call.arguments);
    if (!args) return call.name === "propose" ? this.invalid(["argomenti: JSON non valido"]) : "argomenti non validi: serve un oggetto JSON";
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

  private invalid(problems: string[]): string {
    this.corrections += 1;
    if (this.corrections > MAX_PROPOSE_CORRECTIONS) return EXHAUSTED;
    return "proposta non valida:\n" + problems.join("\n");
  }

  private async propose(args: Record<string, unknown>): Promise<string> {
    // Esaurite le correzioni nessuna proposta passa più, nemmeno se valida
    if (this.corrections >= MAX_PROPOSE_CORRECTIONS + 1) return EXHAUSTED;
    const parsed = ProposeArgs.safeParse(args);
    if (!parsed.success) return this.invalid(formatIssues(parsed.error.issues));
    const { kind, chapter, payload, targetRef, rationale } = parsed.data;

    let target: PlanToolItem | null = null;
    if (kind !== "add") {
      target = (targetRef && this.env.items.get(targetRef)) || null;
      if (!target || target.chapter !== chapter) {
        return this.invalid([`targetRef: voce "${targetRef ?? ""}" non trovata nel capitolo ${chapter}`]);
      }
    }

    let valid: unknown = null;
    if (kind !== "discard") {
      const r = ITEM_SCHEMAS[chapter].safeParse(payload);
      if (!r.success) return this.invalid(formatIssues(r.error.issues));
      valid = r.data;
      if (chapter === "completion") {
        const problems = this.checkDependencies(valid as { key: string; dependsOn: string[] });
        if (problems.length) return this.invalid(problems);
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
