import type { LocalJob } from "@workspace/db";
import {
  executeReadTool,
  MAX_CORRECTIONS,
  phaseTools,
  READ_TOOLS,
  validatePhaseSubmit,
  type PhaseBudget,
  type PhaseOutcome,
  type ReadToolName,
} from "../architect/phase-loop";
import type { PhaseName } from "../architect/schemas";
import type { SourceTree } from "../architect/source-tree";
import type { OpenApiDoc } from "../architect/sources";
import { CLAUDE_EXIT_ERROR, completeItem, isQueueError, ITEM_REPLACED, JOB_EXPIRED, LocalJobError, runItem } from "./jobs";
import { registerJobToolProvider, type JobToolDef, type JobToolInputSchema } from "./mcp-server";

/**
 * Analisi dell'architetto eseguite dall'agente locale: ogni fase è un compito del lavoro `analysis`, che Claude
 * Code esegue con gli strumenti MCP di Casello (le stesse letture di `runPhase` e la consegna della fase).
 *
 * Le sorgenti restano in memoria nel processo dell'analisi: il contesto (albero, OpenAPI, fase corrente, log) vive
 * qui per la durata dell'analisi, cercato per `analysisId`. Senza contesto (analisi finita, riavvio) ogni
 * strumento risponde "lavoro scaduto".
 */

export type AnalysisContext = {
  tree: SourceTree | null;
  openapi: OpenApiDoc | null;
  /** Registro dell'analisi (righe brevi, mai il contenuto delle sorgenti). */
  log: (message: string) => void;
  /** Fase in corso, impostata dall'analisi prima di ogni compito. */
  phase: PhaseName | null;
  /** Consegne non valide del compito in corso (si azzerano con un compito nuovo). */
  invalidSubmits: { itemId: string; count: number } | null;
};

const contexts = new Map<number, AnalysisContext>();

/** Contesto di un'analisi in corso (da chiudere con `closeAnalysisContext` alla fine). */
export function openAnalysisContext(
  analysisId: number,
  input: { tree: SourceTree | null; openapi: OpenApiDoc | null; log: (message: string) => void },
): AnalysisContext {
  const ctx: AnalysisContext = { ...input, phase: null, invalidSubmits: null };
  contexts.set(analysisId, ctx);
  return ctx;
}

export function closeAnalysisContext(analysisId: number): void {
  contexts.delete(analysisId);
}

// --- Strumenti MCP ------------------------------------------------------------------------------------------------

export const SUBMIT_PHASE_TOOL = "submit_phase_result";
const SUBMIT_OK = "consegna ricevuta: fase completata, termina ora";
const NO_PHASE = "nessuna fase in corso";
const ITEM_GONE = ITEM_REPLACED;
/** Consegne non valide ammesse in un compito: oltre, la fase si interrompe. */
export const MAX_INVALID_SUBMITS_PER_ITEM = 5;
const TOO_MANY_INVALID = "troppe consegne non valide: fase interrotta";
// Esito del compito chiuso per troppe consegne non valide (solo in memoria, confrontato per identità)
const PHASE_ABORTED = { aborted: true } as const;

const expired = () => new LocalJobError(410, JOB_EXPIRED);

/**
 * Contesto dell'analisi del lavoro, solo per il compito consegnato. Un lavoro del runner non `running` ha il compito
 * successivo pubblicato ma non ancora consegnato: chi chiama è la sessione di Claude della fase precedente (il token
 * è del lavoro, non del compito) e non deve leggere né consegnare per la fase nuova.
 */
function contextOf(job: Pick<LocalJob, "analysisId" | "claimedBy" | "status">): AnalysisContext {
  const ctx = job.analysisId === null ? undefined : contexts.get(job.analysisId);
  if (!ctx) throw expired();
  if (job.claimedBy === "runner" && job.status !== "running") throw new LocalJobError(409, ITEM_GONE);
  return ctx;
}

function readTool(name: ReadToolName): JobToolDef {
  const { description = "", parameters } = READ_TOOLS[name].function;
  return {
    name,
    description,
    inputSchema: parameters as JobToolInputSchema,
    handler: async ({ job }, args) => {
      const ctx = contextOf(job);
      return { text: await executeReadTool(name, args, ctx) };
    },
  };
}

const submitTool: JobToolDef = {
  name: SUBMIT_PHASE_TOOL,
  description:
    "Consegna l'esito della fase in corso. `result` deve rispettare lo schema richiesto dalla fase; se viene rifiutato, correggi gli errori indicati e consegna di nuovo l'esito completo. Dopo una consegna accettata termina.",
  inputSchema: { type: "object", properties: { result: { type: "object" } }, required: ["result"] },
  handler: async ({ job }, args) => {
    const ctx = contextOf(job);
    const item = job.currentItem;
    if (!ctx.phase || !item) return { text: NO_PHASE, isError: true };
    const hasResult = args !== null && typeof args === "object" && !Array.isArray(args) && "result" in args;
    const check = hasResult
      ? validatePhaseSubmit(ctx.phase, (args as { result: unknown }).result)
      : { ok: false as const, issues: "- result: campo obbligatorio (l'esito va passato come { \"result\": { ... } })" };
    if (!check.ok) {
      const tally = ctx.invalidSubmits?.itemId === item.id ? ctx.invalidSubmits : { itemId: item.id, count: 0 };
      tally.count += 1;
      ctx.invalidSubmits = tally;
      if (tally.count > MAX_INVALID_SUBMITS_PER_ITEM) {
        ctx.log(`${SUBMIT_PHASE_TOOL} non valido (troppe consegne: fase interrotta)`);
        if (!(await completeItem(job.id, item.id, PHASE_ABORTED))) throw new LocalJobError(409, ITEM_GONE);
        return { text: TOO_MANY_INVALID, isError: true };
      }
      ctx.log(`${SUBMIT_PHASE_TOOL} non valido`);
      return {
        text: `Esito non valido: correggi questi problemi e richiama ${SUBMIT_PHASE_TOOL} con l'esito completo, rispettando esattamente la forma dell'esempio della fase.\n${check.issues}`,
        isError: true,
      };
    }
    // Il log prima della consegna: dopo, l'analisi può già passare alla fase successiva (o chiudersi)
    ctx.log(`${SUBMIT_PHASE_TOOL} valido`);
    if (!(await completeItem(job.id, item.id, check.result))) throw new LocalJobError(409, ITEM_GONE);
    return { text: SUBMIT_OK };
  },
};

/** Strumenti del lavoro: le letture delle sorgenti disponibili e la consegna; senza contesto tutte (rispondono "scaduto"). */
async function analysisTools({ job }: { job: { analysisId: number | null } }): Promise<JobToolDef[]> {
  const ctx = job.analysisId === null ? undefined : contexts.get(job.analysisId);
  const tools = phaseTools(ctx ? ctx.tree !== null : true, ctx ? ctx.openapi !== null : true);
  return [
    ...tools.filter((t) => t.function.name in READ_TOOLS).map((t) => readTool(t.function.name as ReadToolName)),
    submitTool,
  ];
}

registerJobToolProvider("analysis", analysisTools);

// --- Fase delegata ------------------------------------------------------------------------------------------------

export const PHASE_NOT_DELIVERED = "fase non consegnata dall'agente locale";

const LOCAL_INSTRUCTIONS = `ISTRUZIONI PER L'AGENTE LOCALE. Usa solo gli strumenti del server MCP "casello": il codice e il contratto OpenAPI dell'app si leggono solo da lì (non leggere file locali, non eseguire comandi, non usare la rete). Quando hai finito consegna l'esito con ${SUBMIT_PHASE_TOOL} (è lo strumento chiamato submit_result nel testo sopra), nel campo result; se viene rifiutato correggi e consegna di nuovo. Dopo una consegna accettata termina.`;

const CORRECTION = `Non hai consegnato un esito valido della fase. Consegna ora l'esito completo con ${SUBMIT_PHASE_TOOL} usando quello che hai già letto con gli strumenti di Casello, rispettando esattamente la forma dell'esempio della fase; poi termina.`;

/**
 * Esegue una fase con l'agente locale: un compito con una sessione nuova di Claude Code (contesto piccolo), poi,
 * se Claude termina senza una consegna valida, fino a `MAX_CORRECTIONS` compiti di correzione sulla stessa
 * sessione. Il tempo è quello dell'analisi (`budget.deadline`); i token riportati da Claude si sommano al budget a
 * titolo informativo (nessun costo per Casello).
 */
export async function runPhaseDelegated(input: {
  jobId: number;
  phase: PhaseName;
  system: string;
  user: string;
  budget: PhaseBudget;
  log: (message: string) => void;
  now?: () => number;
}): Promise<PhaseOutcome> {
  const { jobId, phase, budget, log } = input;
  const now = input.now ?? Date.now;
  const left = budget.deadline - now();
  if (left <= 0) return { ok: false, error: `fase ${phase}: tempo massimo dell'analisi scaduto` };
  const signal = AbortSignal.timeout(left);

  let item = { prompt: `${input.system}\n\n${input.user}\n\n${LOCAL_INSTRUCTIONS}`, resume: false };
  for (let corrections = 0; ; corrections++) {
    let result;
    try {
      result = await runItem(jobId, item, signal);
    } catch (err) {
      if (signal.aborted) return { ok: false, error: `fase ${phase}: tempo massimo dell'analisi scaduto` };
      // Solo i messaggi fissi della coda dei lavori; ogni altro errore lo chiude l'analisi con il testo generico
      if (isQueueError(err)) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
    // Token informativi e incompleti: noti solo dal done del runner, che per un compito chiuso dalla consegna
    // arriva dopo la fine di runItem (quindi non si contano)
    if (result.usage) budget.tokensUsed += result.usage.inputTokens + result.usage.outputTokens;
    // Compito interrotto per troppe consegne non valide: nessuna correzione
    if (result.completion === PHASE_ABORTED) return { ok: false, error: PHASE_NOT_DELIVERED };
    if ("completion" in result) return { ok: true, result: result.completion };
    // Claude Code uscito con errore (abbonamento, accesso): una correzione fallirebbe allo stesso modo
    if (result.exit === "error") {
      log("Claude Code terminato con errore senza consegna");
      return { ok: false, error: CLAUDE_EXIT_ERROR };
    }
    if (corrections >= MAX_CORRECTIONS) {
      log(`agente locale terminato senza consegna valida (correzioni esaurite)`);
      return { ok: false, error: PHASE_NOT_DELIVERED };
    }
    log(`agente locale terminato senza consegna valida: correzione ${corrections + 1}/${MAX_CORRECTIONS}`);
    item = { prompt: CORRECTION, resume: true };
  }
}
