import { aiAccountsTable, aiModelsTable, db } from "@workspace/db";
import { createNode } from "../src/lib/nodes/nodes";
import { NODE_PROVIDER } from "../src/lib/ai/node-account";
import { ensureProviderRegistry } from "../src/lib/catalog/provider-registry";
import { enqueueTurn } from "../src/lib/node-turns/queue";
import type { TurnPackageBody } from "../src/lib/node-turns/queue";
import { ensureUser } from "./team-node-fixture";

// Turni delegati al nodo per i test: utente, nodo (con il suo token d'ambito `node`), account nodo e un modello.

export interface NodeTurnSetup {
  userId: number;
  nodeId: number;
  nodeToken: string;
  aiModelId: number;
}

export async function seedNodeTurnSetup(email: string, nodeName = "Mac"): Promise<NodeTurnSetup> {
  await ensureProviderRegistry();
  const userId = await ensureUser(email);
  const { node, token } = await createNode(userId, nodeName);
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: `Claude Code ${nodeName}`, provider: NODE_PROVIDER, baseUrl: "", apiKeyEnc: null, nodeId: node.id })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "sonnet", displayName: "sonnet (ultimo)" }).returning();
  return { userId, nodeId: node.id, nodeToken: token, aiModelId: model!.id };
}

export const samplePackage = (over: Partial<TurnPackageBody> = {}): TurnPackageBody => ({
  model: "sonnet",
  systemPrompt: "Sei Lucius.\nGli strumenti di Botcave si chiamano mcp__botcave__<nome>: usa solo quelli.",
  prompt: "[utente]\nCiao",
  maxTurns: 7,
  timeoutMs: 300_000,
  ...over,
});

export function queueSample(setup: NodeTurnSetup, over: Partial<TurnPackageBody> = {}) {
  return enqueueTurn({
    nodeId: setup.nodeId,
    userId: setup.userId,
    aiModelId: setup.aiModelId,
    consumer: "character",
    refId: 1,
    messageId: 2,
    pkg: samplePackage(over),
  });
}

/**
 * Modello «Claude Code (nodo)» di un utente già esistente: nodo attivo, account nodo (con il ripiego indicato) e il
 * modello `sonnet`. Per le prove delle scelte dove i modelli nodo non sono ammessi.
 */
export async function nodeModelFor(userId: number, opts: { fallbackAiModelId?: number | null; nodeName?: string } = {}): Promise<number> {
  await ensureProviderRegistry();
  const { node } = await createNode(userId, opts.nodeName ?? `Mac ${Math.random().toString(36).slice(2, 8)}`);
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId,
      name: "Claude Code",
      provider: NODE_PROVIDER,
      baseUrl: "",
      apiKeyEnc: null,
      nodeId: node.id,
      fallbackAiModelId: opts.fallbackAiModelId ?? null,
    })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "sonnet", displayName: "sonnet (ultimo)" }).returning();
  return model!.id;
}
