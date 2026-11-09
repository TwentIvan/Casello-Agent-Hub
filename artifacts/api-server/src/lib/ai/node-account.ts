import { and, asc, eq, ne } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, modelOffersTable } from "@workspace/db";
import type { DiscoveredModel } from "./discovery";

/**
 * Account AI di tipo nodo: i turni li esegue Claude Code sul Mac dell'utente (spec §2). Nessuna chiave né
 * indirizzo; i modelli sono gli alias di Claude Code più le offerte `anthropic` del catalogo, senza prezzi.
 */

/** Slug del provider del registro. */
export const NODE_PROVIDER = "claude_code_node";

/** Alias dei modelli che Claude Code risolve da sé sull'ultima versione. */
export const NODE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/** Un nodo è pronto a ricevere turni se è attivo e ha sondato `/api/node/turns/claim` negli ultimi 60 s. */
export const NODE_TURN_READY_MS = 60_000;

export function nodeTurnReady(node: { status: string; lastTurnPollAt: Date | null }, now: Date = new Date()): boolean {
  return node.status === "active" && node.lastTurnPollAt !== null && now.getTime() - node.lastTurnPollAt.getTime() <= NODE_TURN_READY_MS;
}

function unpriced(modelId: string, displayName: string): DiscoveredModel {
  return { modelId, displayName, contextTokens: null, priceInput: null, priceOutput: null, priceCachedInput: null, priceSource: null };
}

/** Modelli di un account nodo: alias «<alias> (ultimo)» e id del catalogo delle offerte `anthropic` non ritirate. */
export async function nodeAccountModels(): Promise<DiscoveredModel[]> {
  const offers = await db
    .select({ providerModelId: modelOffersTable.providerModelId })
    .from(modelOffersTable)
    .where(and(eq(modelOffersTable.provider, "anthropic"), ne(modelOffersTable.status, "retired")))
    .orderBy(asc(modelOffersTable.providerModelId));
  const aliases = new Set<string>(NODE_MODEL_ALIASES);
  return [
    ...NODE_MODEL_ALIASES.map((a) => unpriced(a, `${a} (ultimo)`)),
    ...offers.filter((o) => !aliases.has(o.providerModelId)).map((o) => unpriced(o.providerModelId, o.providerModelId)),
  ];
}

/** Errore di regola con il suo stato HTTP (le route lo traducono in `{error}`). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const FALLBACK_INVALID = "modello di ripiego non valido";

/**
 * Il modello di ripiego di un account nodo deve essere di un account dell'utente che non sia a sua volta un
 * account nodo (altrimenti il ripiego tornerebbe al nodo). `null` = nessun ripiego. Altrimenti `HttpError` 400.
 */
export async function validateFallback(userId: number, aiModelId: number | null): Promise<void> {
  if (aiModelId === null) return;
  const [row] = await db
    .select({ id: aiModelsTable.id })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(and(eq(aiModelsTable.id, aiModelId), eq(aiAccountsTable.userId, userId), ne(aiAccountsTable.provider, NODE_PROVIDER)))
    .limit(1);
  if (!row) throw new HttpError(400, FALLBACK_INVALID);
}
