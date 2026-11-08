import { db, pendingActionsTable, type Agent, type App, type Run } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { QUEUE_FAILED } from "../agent-loop";
import { logger } from "../logger";
import { internalTool } from "../teams/role-tools";
import { validateArgs } from "../tools/definition";
import { effectiveLevel } from "../tools/levels";
import { maskArgsWithSchema } from "../tools/sensitive";
import type { CatalogTool, ToolResult } from "../tools/types";
import { enqueueProposal } from "./queue";
import {
  PROPOSAL_MESSAGES,
  PROPOSAL_REASON_MAX,
  PROPOSAL_STEPS_MAX,
  PROPOSAL_TITLE_MAX,
  STEP_SUMMARY_MAX,
  parseProposalArgs,
  stepRefs,
} from "./proposal";
import { checkQueuedText } from "./text-check";

// Strumento interno `proponi`: l'agente propone più creazioni o modifiche collegate, che l'utente approva
// in blocco. Non passa dalla coda delle azioni L2 né da `executeTool`: crea una voce `proposal` con i suoi passi.
// Risultati `ok: false` con messaggio fisso, mai eccezioni: la run prosegue in ogni caso.

export const PROPOSE_TOOL_NAME = "proponi";

/** Messaggio fisso per un errore inatteso (DB). */
const PROPOSE_FAILED = "proposta non riuscita: riprova più tardi";

export function proposeTool(): CatalogTool {
  return internalTool(
    PROPOSE_TOOL_NAME,
    "Proponi all'utente più creazioni o modifiche collegate da approvare insieme. Usalo quando servono più azioni " +
      "in sequenza sull'app: i passi si eseguono in ordine solo dopo l'approvazione dell'utente. Un riferimento " +
      "come {{p1.id}} deve essere l'intero valore stringa di un argomento, senza altro testo attorno, e usa il campo `id` " +
      "del risultato del passo p1. Scrivi sintesi " +
      "complete in italiano, senza segnaposto. Una sola proposta per run.",
    {
      type: "object",
      properties: {
        titolo: { type: "string", minLength: 1, maxLength: PROPOSAL_TITLE_MAX, description: "Titolo della proposta" },
        motivo: { type: "string", maxLength: PROPOSAL_REASON_MAX, description: "Perché la proponi" },
        passi: {
          type: "array",
          minItems: 1,
          maxItems: PROPOSAL_STEPS_MAX,
          description: "Passi in ordine di esecuzione",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "p1, p2… nell'ordine" },
              strumento: { type: "string", description: "Nome di uno strumento dell'app" },
              argomenti: { type: "object", description: "Argomenti dello strumento; un valore può essere {{pN.campo}}" },
              sintesi: { type: "string", minLength: 1, maxLength: STEP_SUMMARY_MAX, description: "Cosa fa il passo" },
            },
            required: ["id", "strumento", "argomenti", "sintesi"],
          },
        },
      },
      required: ["titolo", "passi"],
    },
  );
}

/** Tool usabile in un passo: attivo, http o mcp, livello effettivo diverso da L3, identità di servizio. */
export function proposalEligible(tool: CatalogTool): boolean {
  return (
    tool.status === "active" &&
    (tool.kind === "http" || tool.kind === "mcp") &&
    effectiveLevel(tool) !== "L3" &&
    tool.identity === "service"
  );
}

export interface ProposeContext {
  run: Run;
  agent: Agent;
  app: App;
  /** Tool caricati dell'agente, prima della conferma delle scritture e senza strumenti interni. */
  tools: CatalogTool[];
  owner: () => Promise<number | null>;
}

const fail = (content: string): ToolResult => ({ ok: false, content });

export async function handlePropose(ctx: ProposeContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = parseProposalArgs(args);
  if (!parsed.ok) return fail(parsed.message);
  const proposal = parsed.value;

  const stepTools: CatalogTool[] = [];
  for (const step of proposal.steps) {
    const tool = ctx.tools.find((t) => t.name === step.toolName);
    if (!tool || !proposalEligible(tool)) return fail(`strumento ${step.toolName} non disponibile per le proposte`);
    stepTools.push(tool);
  }

  // Gli argomenti con riferimenti si validano dopo la sostituzione, all'approvazione
  for (const [i, step] of proposal.steps.entries()) {
    const refs = stepRefs(step.args);
    if (Array.isArray(refs) && refs.length === 0) {
      const error = validateArgs(stepTools[i]!.paramsSchema, step.args);
      if (error) return fail(`argomenti non validi nel passo ${step.key}: ${error}`);
    }
  }

  const maskedSteps = proposal.steps.map((step, i) => ({
    key: step.key,
    toolName: step.toolName,
    args: maskArgsWithSchema(stepTools[i]!.paramsSchema, step.args),
    summary: step.summary,
  }));
  const problems = checkQueuedText({
    recipient: ctx.app.name,
    summary: proposal.title,
    args: { summaries: maskedSteps.map((s) => s.summary), steps: maskedSteps.map((s) => s.args) },
  });
  if (problems.length > 0) return fail(`testo non pronto: ${problems.join("; ")}`);

  try {
    const [existing] = await db
      .select({ id: pendingActionsTable.id })
      .from(pendingActionsTable)
      .where(
        and(
          eq(pendingActionsTable.kind, "proposal"),
          eq(pendingActionsTable.status, "pending"),
          eq(pendingActionsTable.runId, ctx.run.id),
        ),
      )
      .limit(1);
    if (existing) return fail(PROPOSAL_MESSAGES.alreadyProposed);

    const userId = await ctx.owner();
    if (userId === null) return fail(QUEUE_FAILED);

    const queued = await enqueueProposal({
      userId,
      appId: ctx.agent.appId,
      agentId: ctx.agent.id,
      runId: ctx.run.id,
      recipient: ctx.app.name,
      proposal,
      publicProposal: { title: proposal.title, reason: proposal.reason, steps: maskedSteps },
      steps: proposal.steps.map((s, i) => ({ key: s.key, position: i, toolId: stepTools[i]!.id, summary: s.summary })),
    });
    if (!queued.ok) return fail(queued.message);
    return { ok: true, content: JSON.stringify({ ok: true, numero: queued.number }) };
  } catch (err) {
    logger.error({ runId: ctx.run.id, errName: err instanceof Error ? err.name : typeof err }, "Proposta non riuscita");
    return fail(PROPOSE_FAILED);
  }
}
