import { eq, sql } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, providersTable, type AiAccount } from "@workspace/db";
import { decryptSecret } from "../secrets";
import { discoverModels, ProviderError, type DiscoveredModel } from "./discovery";
import { privateNetworkAllowed } from "./providers";

// Modelli degli account AI: salvataggio dei modelli scoperti, verifica di un account e arricchimento
// dal catalogo. Usati dalle route degli account e dall'aggiornamento del catalogo.

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function toPrice(v: number | null | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * Collega i modelli degli account alle offerte del catalogo per (provider dell'account, id normalizzato come
 * `normalizeModelId`, cioè come `provider_model_id`): `offer_id` (null senza abbinamento), `supports_tools` e,
 * se il prezzo non è manuale e l'offerta li ha entrambi, i prezzi (anche quello dei token in cache, null se
 * l'offerta non lo ha) con `price_source = 'catalog'`. Esclusi gli
 * account `custom` e di sistema; quelli di un provider non gestito si abbinano alle offerte di quel provider.
 * L'id del modello non cambia mai (i provider possono distinguere le maiuscole).
 */
export async function enrichFromCatalog(executor: Tx | typeof db, opts: { accountId?: number }): Promise<void> {
  const onlyAccount = opts.accountId === undefined ? sql.empty() : sql`AND a.id = ${opts.accountId}`;
  await executor.execute(sql`
    WITH matched AS (
      SELECT m.id AS model_row_id,
             o.id AS offer_id,
             o.supports_tools,
             o.price_input_per_mtok,
             o.price_output_per_mtok,
             o.price_cached_input_per_mtok,
             (o.id IS NOT NULL
               AND m.price_source IS DISTINCT FROM 'manual'
               AND o.price_input_per_mtok IS NOT NULL
               AND o.price_output_per_mtok IS NOT NULL) AS take_price
      FROM ai_models m
      JOIN ai_accounts a ON a.id = m.account_id
      LEFT JOIN model_offers o
        ON o.provider = a.provider
       AND o.provider_model_id = lower(regexp_replace(m.model_id, '^models/', '', 'i'))
      WHERE a.provider NOT IN ('custom', 'system_gateway') ${onlyAccount}
    )
    UPDATE ai_models AS m SET
      offer_id = x.offer_id,
      supports_tools = CASE WHEN x.offer_id IS NULL THEN m.supports_tools ELSE x.supports_tools END,
      price_input_per_mtok = CASE WHEN x.take_price THEN x.price_input_per_mtok ELSE m.price_input_per_mtok END,
      price_output_per_mtok = CASE WHEN x.take_price THEN x.price_output_per_mtok ELSE m.price_output_per_mtok END,
      price_cached_input_per_mtok = CASE WHEN x.take_price THEN x.price_cached_input_per_mtok ELSE m.price_cached_input_per_mtok END,
      price_source = CASE WHEN x.take_price THEN 'catalog' ELSE m.price_source END,
      updated_at = now()
    FROM matched x
    WHERE m.id = x.model_row_id
  `);
}

/**
 * Salva i modelli scoperti: inserisce i nuovi; sugli esistenti aggiorna il contesto e i prezzi (solo
 * se non sono stati inseriti a mano), mai il nome (le rinomine dell'utente restano). I modelli non più elencati restano (agenti e analisi
 * possono usarli) e il flag `discovered` degli esistenti non cambia. Alla fine riapplica il catalogo,
 * così i prezzi del catalogo non si perdono.
 */
export async function upsertDiscovered(tx: Tx, accountId: number, models: DiscoveredModel[]): Promise<void> {
  const manual = sql`${aiModelsTable.priceSource} = 'manual'`;
  for (let i = 0; i < models.length; i += 500) {
    const chunk = models.slice(i, i + 500);
    await tx
      .insert(aiModelsTable)
      .values(
        chunk.map((m) => ({
          accountId,
          modelId: m.modelId,
          displayName: m.displayName,
          contextTokens: m.contextTokens,
          priceInputPerMtok: toPrice(m.priceInput),
          priceOutputPerMtok: toPrice(m.priceOutput),
          priceCachedInputPerMtok: toPrice(m.priceCachedInput),
          priceSource: m.priceSource,
          discovered: true,
        })),
      )
      .onConflictDoUpdate({
        target: [aiModelsTable.accountId, aiModelsTable.modelId],
        set: {
          contextTokens: sql`excluded.context_tokens`,
          priceInputPerMtok: sql`CASE WHEN ${manual} THEN ${aiModelsTable.priceInputPerMtok} ELSE excluded.price_input_per_mtok END`,
          priceOutputPerMtok: sql`CASE WHEN ${manual} THEN ${aiModelsTable.priceOutputPerMtok} ELSE excluded.price_output_per_mtok END`,
          priceCachedInputPerMtok: sql`CASE WHEN ${manual} THEN ${aiModelsTable.priceCachedInputPerMtok} ELSE excluded.price_cached_input_per_mtok END`,
          priceSource: sql`CASE WHEN ${manual} THEN ${aiModelsTable.priceSource} ELSE excluded.price_source END`,
          updatedAt: new Date(),
        },
      });
  }
  await enrichFromCatalog(tx, { accountId });
}

/**
 * Rilegge i modelli di un account già salvato e ne registra lo stato. Un errore del provider non
 * lancia: l'account passa a `error` con il messaggio fisso e il risultato è null. "Nessun elenco dei
 * modelli" non è un errore (i modelli si aggiungono a mano): risultato `[]`.
 */
export async function verifyAccount(account: AiAccount): Promise<DiscoveredModel[] | null> {
  const now = new Date();
  let models: DiscoveredModel[];
  try {
    let apiKey: string | null = null;
    if (account.apiKeyEnc !== null) {
      try {
        apiKey = decryptSecret(account.apiKeyEnc);
      } catch {
        // Chiave non decifrabile (es. CASELLO_SECRET_KEY cambiata): va reinserita
        throw new ProviderError("auth");
      }
    }
    // Il consenso salvato vale solo finché il provider è custom o non gestito (come nell'esecutore)
    const [provider] = await db
      .select({ slug: providersTable.slug, status: providersTable.status })
      .from(providersTable)
      .where(eq(providersTable.slug, account.provider))
      .limit(1);
    models = await discoverModels({
      provider: account.provider,
      baseUrl: account.baseUrl,
      apiKey,
      allowPrivateNetwork: account.allowPrivateNetwork && provider !== undefined && privateNetworkAllowed(provider),
    });
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.kind === "no_models") {
      models = [];
    } else {
      await db
        .update(aiAccountsTable)
        .set({ status: "error", lastError: err.message, lastCheckedAt: now, updatedAt: now })
        .where(eq(aiAccountsTable.id, account.id));
      return null;
    }
  }
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(aiAccountsTable)
      .set({ status: "ok", lastError: null, lastCheckedAt: now, updatedAt: now })
      .where(eq(aiAccountsTable.id, account.id))
      .returning({ id: aiAccountsTable.id });
    // Account eliminato durante la verifica: niente modelli orfani (la route risponde 404)
    if (updated.length) await upsertDiscovered(tx, account.id, models);
  });
  return models;
}
