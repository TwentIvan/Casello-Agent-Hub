import type { TeamInstanceRow } from "@workspace/db";
import { resolveModel, type ResolvedModel } from "../ai/executor";
import { InstanceRoleSchema } from "../teams/manifest";
import { usableNodeFallback } from "../teams/node-fallback";
import { teamBudgetBlock } from "../teams/team-budget";
import { COLLAUDO_MESSAGES } from "./messages";

// Modello del collaudatore: quello del capo della squadra. Con un modello Claude Code (nodo) il collaudo usa il ripiego cloud
// dell'account (il collaudatore gira solo in Botcave); senza ripiego usabile il collaudo si salta. I tetti sono quelli dei compiti:
// prima la squadra (o il ciclo), poi modello, account e utente.

export type TestModel = { aiModelId: number; resolved: ResolvedModel } | { skip: string };

export async function testModelFor(instance: TeamInstanceRow): Promise<TestModel> {
  const roles = InstanceRoleSchema.array().safeParse(instance.roles);
  const lead = roles.success ? roles.data.find((r) => r.isLead) : undefined;
  if (!lead || lead.aiModelId === null) return { skip: COLLAUDO_MESSAGES.noModel };

  let resolved: ResolvedModel;
  try {
    resolved = await resolveModel(lead.aiModelId, { userId: null, mustOwn: false });
  } catch {
    return { skip: COLLAUDO_MESSAGES.noModel };
  }

  if (resolved.kind === "node") {
    if (resolved.fallbackAiModelId === null) return { skip: COLLAUDO_MESSAGES.nodeNoFallback };
    // Il tetto raggiunto dà il suo motivo, non quello del ripiego mancante
    const block = await teamBudgetBlock(instance.id, resolved.fallbackAiModelId);
    if (block) return { skip: block };
    const fallback = await usableNodeFallback(instance.id, resolved);
    if (!fallback) return { skip: COLLAUDO_MESSAGES.nodeNoFallback };
    return { aiModelId: fallback.resolved.aiModelId, resolved: fallback.resolved };
  }

  const block = await teamBudgetBlock(instance.id, lead.aiModelId);
  if (block) return { skip: block };
  return { aiModelId: lead.aiModelId, resolved };
}
