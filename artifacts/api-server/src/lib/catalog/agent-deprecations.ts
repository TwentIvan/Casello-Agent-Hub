import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import { db, agentsTable, aiAccountsTable, aiModelsTable, appsTable, modelOffersTable } from "@workspace/db";
import { NODE_PROVIDER } from "../ai/node-account";
import { effectiveStatus, isPreviewModel, isSelectable, type EffectiveStatus } from "../ai/model-status";

// Agenti con il modello in dismissione (issue #114): il catalogo conosce la data di dismissione delle offerte; qui si
// trovano gli agenti il cui modello è ritirato o ha la dismissione entro 30 giorni e si propone il sostituto più
// economico con strumenti tra i modelli dell'utente. Solo letture, nessuna chiamata a modelli.

/** Entro quanti giorni dalla dismissione si avvisa (lo stesso valore dell'avviso in console). */
export const DEPRECATION_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReplacementCandidate {
  id: number;
  name: string;
  accountName: string;
  modelId: string;
  priceInput: number | null;
  priceOutput: number | null;
  status: EffectiveStatus;
  supportsTools: boolean | null;
  deprecationDate: Date | null;
  /** Modello di un account «Claude Code (nodo)» (prezzi nulli, non confrontabile). */
  node: boolean;
}

export interface ModelReplacement {
  aiModelId: number;
  name: string;
  accountName: string;
  priceInput: number;
  priceOutput: number;
}

export interface AgentDeprecation {
  agentId: number;
  agentName: string;
  appId: number;
  appName: string;
  aiModelId: number;
  modelName: string;
  /** Proprietario dell'account del modello: solo lui vede la voce nel riepilogo del catalogo. */
  ownerUserId: number;
  /** Giorno della dismissione (AAAA-MM-GG); null per un modello ritirato senza data. */
  deprecationDate: string | null;
  retired: boolean;
  replacement: ModelReplacement | null;
}

/** Dismissione entro la finestra dell'avviso (o già passata). */
export function deprecatesSoon(deprecationDate: Date | null, now: Date): boolean {
  return deprecationDate !== null && deprecationDate.getTime() <= now.getTime() + DEPRECATION_WARNING_DAYS * DAY_MS;
}

/**
 * Sostituto più economico (prezzo di input + output) tra i candidati: selezionabile, con strumenti, prezzi noti, non in
 * anteprima, non del nodo, senza dismissione vicina e diverso dal modello attuale. Parità: nome, poi id. null se nessuno.
 */
export function pickReplacement(candidates: ReplacementCandidate[], currentAiModelId: number, now: Date): ModelReplacement | null {
  let best: (ReplacementCandidate & { priceInput: number; priceOutput: number }) | null = null;
  for (const c of candidates) {
    if (c.id === currentAiModelId || c.node) continue;
    if (c.priceInput === null || c.priceOutput === null) continue;
    if (c.supportsTools !== true || isPreviewModel(c.modelId) || !isSelectable(c.status, c.supportsTools, c.modelId)) continue;
    if (deprecatesSoon(c.deprecationDate, now)) continue;
    const total = c.priceInput + c.priceOutput;
    if (
      best === null ||
      total < best.priceInput + best.priceOutput ||
      (total === best.priceInput + best.priceOutput && (c.name.localeCompare(best.name) < 0 || (c.name === best.name && c.id < best.id)))
    ) {
      best = { ...c, priceInput: c.priceInput, priceOutput: c.priceOutput };
    }
  }
  return best && { aiModelId: best.id, name: best.name, accountName: best.accountName, priceInput: best.priceInput, priceOutput: best.priceOutput };
}

const toNumber = (v: string | null): number | null => (v === null ? null : Number(v));

/** Modelli non nascosti degli account di un utente, come candidati sostituti. */
async function candidatesOf(userIds: number[], now: Date): Promise<Map<number, ReplacementCandidate[]>> {
  const out = new Map<number, ReplacementCandidate[]>(userIds.map((id) => [id, []]));
  if (!userIds.length) return out;
  const rows = await db
    .select({ model: aiModelsTable, account: aiAccountsTable, offer: modelOffersTable })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .leftJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
    .where(and(inArray(aiAccountsTable.userId, userIds), eq(aiModelsTable.hidden, false)));
  for (const { model, account, offer } of rows) {
    const deprecationDate = offer?.deprecationDate ?? null;
    out.get(account.userId!)?.push({
      id: model.id,
      name: model.displayName,
      accountName: account.name,
      modelId: model.modelId,
      priceInput: toNumber(model.priceInputPerMtok),
      priceOutput: toNumber(model.priceOutputPerMtok),
      status: effectiveStatus({ availability: model.availability, catalogStatus: offer?.status ?? null, deprecationDate }, now),
      supportsTools: offer ? offer.supportsTools : model.supportsTools,
      deprecationDate,
      node: account.provider === NODE_PROVIDER,
    });
  }
  return out;
}

/**
 * Agenti con il modello ritirato o in dismissione entro `DEPRECATION_WARNING_DAYS` giorni, ordinati per dismissione (i
 * ritirati senza data per primi) e poi per nome. Il sostituto si cerca tra i modelli di `candidatesFor` (es. l'utente della
 * richiesta) o, senza, tra quelli del proprietario del modello dell'agente.
 */
export async function findDeprecatingAgents(opts: { now?: Date; candidatesFor?: number } = {}): Promise<AgentDeprecation[]> {
  const now = opts.now ?? new Date();
  const limit = new Date(now.getTime() + DEPRECATION_WARNING_DAYS * DAY_MS);
  const rows = await db
    .select({
      agentId: agentsTable.id,
      agentName: agentsTable.name,
      appId: agentsTable.appId,
      appName: appsTable.name,
      aiModelId: aiModelsTable.id,
      modelName: aiModelsTable.displayName,
      ownerUserId: aiAccountsTable.userId,
      offerStatus: modelOffersTable.status,
      deprecationDate: modelOffersTable.deprecationDate,
    })
    .from(agentsTable)
    .innerJoin(appsTable, eq(agentsTable.appId, appsTable.id))
    .innerJoin(aiModelsTable, eq(agentsTable.aiModelId, aiModelsTable.id))
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .innerJoin(modelOffersTable, eq(aiModelsTable.offerId, modelOffersTable.id))
    .where(
      and(
        isNotNull(aiAccountsTable.userId),
        or(eq(modelOffersTable.status, "retired"), lte(modelOffersTable.deprecationDate, limit)),
      ),
    );
  if (!rows.length) return [];

  const users = [...new Set(opts.candidatesFor !== undefined ? [opts.candidatesFor] : rows.map((r) => r.ownerUserId!))];
  const candidates = await candidatesOf(users, now);
  const out: AgentDeprecation[] = rows.map((r) => ({
    agentId: r.agentId,
    agentName: r.agentName,
    appId: r.appId,
    appName: r.appName,
    aiModelId: r.aiModelId,
    modelName: r.modelName,
    ownerUserId: r.ownerUserId!,
    deprecationDate: r.deprecationDate ? r.deprecationDate.toISOString().slice(0, 10) : null,
    retired: r.offerStatus === "retired" || (r.deprecationDate !== null && r.deprecationDate.getTime() <= now.getTime()),
    replacement: pickReplacement(candidates.get(opts.candidatesFor ?? r.ownerUserId!) ?? [], r.aiModelId, now),
  }));
  return out.sort(
    (a, b) =>
      (a.deprecationDate ?? "").localeCompare(b.deprecationDate ?? "") ||
      a.agentName.localeCompare(b.agentName, "it") ||
      a.agentId - b.agentId,
  );
}
