import { Router, type IRouter, type RequestHandler, type Response } from "express";
import { and, asc, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  usersTable,
  type AiAccount,
  type AiModel,
} from "@workspace/db";
import {
  AddAiAccountModelBody,
  AddAiAccountModelParams,
  AddAiAccountModelResponse,
  CreateAiAccountBody,
  CreateAiAccountResponse,
  DeleteAiAccountParams,
  EstimateAnalysisCostQueryParams,
  EstimateAnalysisCostResponse,
  ListAiAccountModelsParams,
  ListAiAccountModelsResponse,
  ListAiAccountsResponse,
  ListAiModelsResponse,
  SetDefaultAiAccountParams,
  SetDefaultAiAccountResponse,
  UpdateAiAccountBody,
  UpdateAiAccountParams,
  UpdateAiAccountResponse,
  UpdateAiModelBody,
  UpdateAiModelParams,
  UpdateAiModelResponse,
  VerifyAiAccountParams,
  VerifyAiAccountResponse,
} from "@workspace/api-zod";
import { currentUserId } from "../lib/auth";
import { ANALYSIS_DEFAULT_MAX_TOKENS } from "../lib/architect/run-analysis";
import { discoverModels, ProviderError, type DiscoveredModel } from "../lib/ai/discovery";
import { normalizeBaseUrl, PROVIDERS, validateBaseUrl, type AiProvider } from "../lib/ai/providers";
import { isUniqueViolation } from "../lib/pg-errors";
import { decryptSecret, encryptSecret } from "../lib/secrets";
import { rateLimit } from "../middlewares/rate-limit";
import { parseRequest } from "../middlewares/error-handler";

// Account AI dell'utente (provider, chiave cifrata, modelli e prezzi) e stima dei costi.
// Ogni route vede solo gli account dell'utente corrente più l'account di sistema (gateway di
// Casello), che si può leggere ma non modificare. La chiave non esce mai: solo `keySet`.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ACCOUNT_NOT_FOUND = "account non trovato";
const MODEL_NOT_FOUND = "modello non trovato";
const SYSTEM_READONLY = "account di sistema non modificabile";
const PRIVATE_ONLY_CUSTOM = "allowPrivateNetwork è ammesso solo per gli account personalizzati (custom)";
const BASE_URL_ONLY_CUSTOM = "base URL modificabile solo per gli account personalizzati (custom)";
const BASE_URL_REQUIRED = "base URL obbligatorio per gli account personalizzati (custom)";
const KEY_REQUIRED = "chiave obbligatoria per questo provider";
const NAME_REQUIRED = "nome obbligatorio, senza caratteri di controllo";
const BAD_MODEL_ID = "id del modello non valido";
const MODEL_EXISTS = "modello già presente nell'account";
const USED_BY_MAX_NAMES = 10;

// Caratteri di controllo C0, DEL e C1
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function isSystemAccount(a: AiAccount): boolean {
  return a.provider === "system_gateway" && a.userId === null;
}

/** L'account di sistema compare negli elenchi solo finché le variabili del gateway sono impostate. */
function systemConfigured(): boolean {
  return !!process.env["AI_GATEWAY_BASE_URL"] && !!process.env["AI_GATEWAY_API_KEY"];
}

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toPrice(v: number | null | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Forma pubblica di un account: mai `apiKeyEnc` né `userId`. */
function toPublicAccount(a: AiAccount, modelCount: number) {
  const system = isSystemAccount(a);
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    // L'indirizzo del gateway di sistema (spesso interno) non si espone
    baseUrl: system ? "" : a.baseUrl,
    allowPrivateNetwork: a.allowPrivateNetwork,
    isDefault: a.isDefault,
    status: a.status,
    lastError: a.lastError,
    lastCheckedAt: a.lastCheckedAt,
    // La chiave del sistema arriva dall'ambiente, non dal DB
    keySet: system ? systemConfigured() : a.apiKeyEnc !== null,
    isSystem: system,
    modelCount,
  };
}

function toPublicModel(m: AiModel) {
  return {
    id: m.id,
    accountId: m.accountId,
    modelId: m.modelId,
    displayName: m.displayName,
    contextTokens: m.contextTokens,
    priceInput: toNumber(m.priceInputPerMtok),
    priceOutput: toNumber(m.priceOutputPerMtok),
    priceSource: m.priceSource as "provider" | "manual" | "seed" | null,
    hidden: m.hidden,
  };
}

/**
 * Condizione "visibile all'utente": suoi account o account di sistema, quest'ultimo solo finché le
 * variabili del gateway sono impostate (dopo la dismissione sparisce da ogni route).
 */
function visibleTo(userId: number) {
  if (!systemConfigured()) return eq(aiAccountsTable.userId, userId);
  return or(
    eq(aiAccountsTable.userId, userId),
    and(isNull(aiAccountsTable.userId), eq(aiAccountsTable.provider, "system_gateway")),
  );
}

async function findVisibleAccount(id: number, userId: number): Promise<AiAccount | undefined> {
  const [row] = await db
    .select()
    .from(aiAccountsTable)
    .where(and(eq(aiAccountsTable.id, id), visibleTo(userId)))
    .limit(1);
  return row;
}

/**
 * Account modificabile dall'utente: altrui o inesistente → 404, di sistema → 403 (risposta già
 * inviata, restituisce undefined).
 */
async function findWritableAccount(id: number, userId: number, res: Response): Promise<AiAccount | undefined> {
  const account = await findVisibleAccount(id, userId);
  if (!account) {
    res.status(404).json({ error: ACCOUNT_NOT_FOUND });
    return undefined;
  }
  if (isSystemAccount(account)) {
    res.status(403).json({ error: SYSTEM_READONLY });
    return undefined;
  }
  return account;
}

async function modelCounts(accountIds: number[]): Promise<Map<number, number>> {
  if (!accountIds.length) return new Map();
  const rows = await db
    .select({ accountId: aiModelsTable.accountId, n: count() })
    .from(aiModelsTable)
    .where(inArray(aiModelsTable.accountId, accountIds))
    .groupBy(aiModelsTable.accountId);
  return new Map(rows.map((r) => [r.accountId, Number(r.n)]));
}

/** Forma pubblica riletta dal DB; undefined se l'account è sparito nel frattempo. */
async function publicAccount(id: number) {
  const [account] = await db.select().from(aiAccountsTable).where(eq(aiAccountsTable.id, id));
  if (!account) return undefined;
  const counts = await modelCounts([id]);
  return toPublicAccount(account, counts.get(id) ?? 0);
}

/** Risponde con l'account riletto, o 404 se è stato eliminato durante la richiesta. */
async function sendAccount(res: Response, id: number, schema: { parse(v: unknown): unknown }, status = 200) {
  const account = await publicAccount(id);
  if (!account) {
    res.status(404).json({ error: ACCOUNT_NOT_FOUND });
    return;
  }
  res.status(status).json(schema.parse(account));
}

/** Nome dell'account ripulito; null se vuoto o con caratteri di controllo. */
function cleanName(raw: string): string | null {
  const name = raw.trim();
  return name && !CONTROL_RE.test(name) ? name : null;
}

/**
 * Account visibili all'utente, nell'ordine della console: il predefinito, poi per nome, quelli in
 * errore in fondo; l'account di sistema (se configurato) per ultimo.
 */
async function visibleAccountsSorted(userId: number): Promise<AiAccount[]> {
  const rows = await db.select().from(aiAccountsTable).where(visibleTo(userId));
  const rank = (a: AiAccount) => (isSystemAccount(a) ? 3 : a.isDefault ? 0 : a.status === "error" ? 2 : 1);
  return rows
    .filter((a) => !isSystemAccount(a) || systemConfigured())
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "it") || a.id - b.id);
}

/** Blocca la riga dell'utente: serializza le operazioni sul predefinito (indice unico parziale). */
async function lockUser(tx: Tx, userId: number): Promise<void> {
  await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
}

/**
 * Salva i modelli scoperti: inserisce i nuovi; sugli esistenti aggiorna il contesto e i prezzi (solo
 * se non sono stati inseriti a mano), mai il nome (le rinomine dell'utente restano). I modelli non più elencati restano (agenti e analisi
 * possono usarli) e il flag `discovered` degli esistenti non cambia.
 */
async function upsertDiscovered(tx: Tx, accountId: number, models: DiscoveredModel[]): Promise<void> {
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
          priceSource: sql`CASE WHEN ${manual} THEN ${aiModelsTable.priceSource} ELSE excluded.price_source END`,
          updatedAt: new Date(),
        },
      });
  }
}

/**
 * Rilegge i modelli di un account già salvato e ne registra lo stato. Un errore del provider non
 * lancia: l'account passa a `error` con il messaggio fisso. "Nessun elenco dei modelli" non è un
 * errore (i modelli si aggiungono a mano).
 */
async function verifyAccount(account: AiAccount): Promise<void> {
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
    models = await discoverModels({
      provider: account.provider,
      baseUrl: account.baseUrl,
      apiKey,
      allowPrivateNetwork: account.provider === "custom" && account.allowPrivateNetwork,
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
      return;
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
}

/** "account usato da: <agenti>, analisi #<id>": al massimo 10 nomi, poi "…"; null se libero. */
async function usedByMessage(accountId: number): Promise<string | null> {
  const modelIds = db.select({ id: aiModelsTable.id }).from(aiModelsTable).where(eq(aiModelsTable.accountId, accountId));
  const agents = await db
    .select({ name: agentsTable.name })
    .from(agentsTable)
    .where(inArray(agentsTable.aiModelId, modelIds))
    .orderBy(asc(agentsTable.name), asc(agentsTable.id))
    .limit(USED_BY_MAX_NAMES + 1);
  const analyses = await db
    .select({ id: analysesTable.id })
    .from(analysesTable)
    .where(inArray(analysesTable.aiModelId, modelIds))
    .orderBy(asc(analysesTable.id))
    .limit(USED_BY_MAX_NAMES + 1);
  const names = [...agents.map((a) => a.name), ...analyses.map((a) => `analisi #${a.id}`)];
  if (!names.length) return null;
  const shown = names.slice(0, USED_BY_MAX_NAMES);
  return `account usato da: ${shown.join(", ")}${names.length > USED_BY_MAX_NAMES ? ", …" : ""}`;
}

/** Violazione di chiave esterna (23503): un riferimento arrivato tra il controllo e l'eliminazione. */
function isForeignKeyViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 4 && current; i++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (e.code === "23503") return true;
    current = e.cause;
  }
  return false;
}

/** Arrotondamento a 4 decimali (USD). */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function createAiRouter(opts: { providerRateLimit?: RequestHandler } = {}): IRouter {
  const router: IRouter = Router();
  // Le route che chiamano un provider esterno (creazione, verifica, modifica) hanno un limite per IP,
  // separato da quello delle run: 20 al minuto.
  const providerLimit = opts.providerRateLimit ?? rateLimit({ limit: 20, windowMs: 60_000 });

  router.get("/ai/accounts", async (req, res) => {
    const accounts = await visibleAccountsSorted(currentUserId(req));
    const counts = await modelCounts(accounts.map((a) => a.id));
    res.json(ListAiAccountsResponse.parse(accounts.map((a) => toPublicAccount(a, counts.get(a.id) ?? 0))));
  });

  router.post("/ai/accounts", providerLimit, async (req, res) => {
    const userId = currentUserId(req);
    const body = parseRequest(CreateAiAccountBody, req.body);
    const provider: AiProvider = body.provider;
    if (provider === "system_gateway") {
      res.status(400).json({ error: "provider non ammesso: l'account di sistema lo gestisce Casello" });
      return;
    }
    const isCustom = provider === "custom";
    const allowPrivateNetwork = body.allowPrivateNetwork === true;
    if (allowPrivateNetwork && !isCustom) {
      res.status(400).json({ error: PRIVATE_ONLY_CUSTOM });
      return;
    }
    const name = cleanName(body.name);
    if (!name) {
      res.status(400).json({ error: NAME_REQUIRED });
      return;
    }

    let baseUrl: string;
    const requested = body.baseUrl == null ? "" : normalizeBaseUrl(body.baseUrl);
    if (isCustom) {
      if (!requested) {
        res.status(400).json({ error: BASE_URL_REQUIRED });
        return;
      }
      baseUrl = requested;
    } else {
      baseUrl = PROVIDERS[provider].defaultBaseUrl!;
      // La console può rimandare il base URL precompilato: ammesso solo se coincide
      if (requested && requested !== baseUrl) {
        res.status(400).json({ error: BASE_URL_ONLY_CUSTOM });
        return;
      }
    }
    const urlError = validateBaseUrl(baseUrl, allowPrivateNetwork);
    if (urlError) {
      res.status(400).json({ error: urlError });
      return;
    }

    const apiKey = body.apiKey?.trim() || null;
    if (apiKey === null && !isCustom) {
      res.status(400).json({ error: KEY_REQUIRED });
      return;
    }

    // Chiave in chiaro solo in memoria, per la scoperta dei modelli
    let models: DiscoveredModel[];
    try {
      models = await discoverModels({ provider, baseUrl, apiKey, allowPrivateNetwork });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind !== "no_models") {
        res.status(400).json({ error: err.message });
        return;
      }
      models = [];
    }

    const apiKeyEnc = apiKey === null ? null : encryptSecret(apiKey);
    const now = new Date();
    const id = await db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const [current] = await tx
        .select({ id: aiAccountsTable.id })
        .from(aiAccountsTable)
        .where(and(eq(aiAccountsTable.userId, userId), eq(aiAccountsTable.isDefault, true)))
        .limit(1);
      const [created] = await tx
        .insert(aiAccountsTable)
        .values({
          userId,
          name,
          provider,
          baseUrl,
          apiKeyEnc,
          allowPrivateNetwork,
          isDefault: !current,
          status: "ok",
          lastError: null,
          lastCheckedAt: now,
        })
        .returning({ id: aiAccountsTable.id });
      await upsertDiscovered(tx, created!.id, models);
      return created!.id;
    });
    await sendAccount(res, id, CreateAiAccountResponse, 201);
  });

  router.patch("/ai/accounts/:id", providerLimit, async (req, res) => {
    const userId = currentUserId(req);
    const { id } = parseRequest(UpdateAiAccountParams, req.params);
    const body = parseRequest(UpdateAiAccountBody, req.body);
    const account = await findWritableAccount(id, userId, res);
    if (!account) return;
    const isCustom = account.provider === "custom";

    const set: Partial<typeof aiAccountsTable.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) {
        res.status(400).json({ error: NAME_REQUIRED });
        return;
      }
      set.name = name;
    }

    let allowPrivateNetwork = account.allowPrivateNetwork;
    if (body.allowPrivateNetwork !== undefined) {
      if (body.allowPrivateNetwork && !isCustom) {
        res.status(400).json({ error: PRIVATE_ONLY_CUSTOM });
        return;
      }
      allowPrivateNetwork = body.allowPrivateNetwork;
    }
    let baseUrl = account.baseUrl;
    if (body.baseUrl !== undefined) {
      const requested = normalizeBaseUrl(body.baseUrl);
      if (!isCustom && requested !== account.baseUrl) {
        res.status(400).json({ error: BASE_URL_ONLY_CUSTOM });
        return;
      }
      if (!requested) {
        res.status(400).json({ error: BASE_URL_REQUIRED });
        return;
      }
      baseUrl = requested;
    }
    const connectionChanged = baseUrl !== account.baseUrl || allowPrivateNetwork !== account.allowPrivateNetwork;
    if (connectionChanged) {
      const urlError = validateBaseUrl(baseUrl, allowPrivateNetwork);
      if (urlError) {
        res.status(400).json({ error: urlError });
        return;
      }
    }

    // Chiave: assente o "" = invariata; null = rimossa (solo custom); un valore la sostituisce
    let newKey: { plain: string | null } | null = null;
    if (body.apiKey === null) {
      if (!isCustom) {
        res.status(400).json({ error: KEY_REQUIRED });
        return;
      }
      if (account.apiKeyEnc !== null) newKey = { plain: null };
    } else if (body.apiKey !== undefined && body.apiKey.trim() !== "") {
      newKey = { plain: body.apiKey.trim() };
    }

    const now = new Date();
    if (newKey === null && !connectionChanged) {
      // Solo il nome: nessuna chiamata al provider
      if (Object.keys(set).length) {
        await db.update(aiAccountsTable).set({ ...set, updatedAt: now }).where(eq(aiAccountsTable.id, account.id));
      }
      await sendAccount(res, account.id, UpdateAiAccountResponse);
      return;
    }

    // Chiave, indirizzo o consenso nuovi: si verificano in memoria con i valori candidati PRIMA di
    // salvarli. Se il provider li rifiuta → 400 e l'account resta com'era (chiave, URL, stato, modelli).
    let models: DiscoveredModel[];
    try {
      let apiKey: string | null;
      if (newKey !== null) {
        apiKey = newKey.plain;
      } else if (account.apiKeyEnc === null) {
        apiKey = null;
      } else {
        try {
          apiKey = decryptSecret(account.apiKeyEnc);
        } catch {
          throw new ProviderError("auth");
        }
      }
      models = await discoverModels({ provider: account.provider, baseUrl, apiKey, allowPrivateNetwork });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind !== "no_models") {
        res.status(400).json({ error: err.message });
        return;
      }
      models = [];
    }

    if (connectionChanged) {
      set.baseUrl = baseUrl;
      set.allowPrivateNetwork = allowPrivateNetwork;
    }
    if (newKey !== null) set.apiKeyEnc = newKey.plain === null ? null : encryptSecret(newKey.plain);
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(aiAccountsTable)
        .set({ ...set, status: "ok", lastError: null, lastCheckedAt: now, updatedAt: now })
        .where(eq(aiAccountsTable.id, account.id))
        .returning({ id: aiAccountsTable.id });
      // Account eliminato nel frattempo: sendAccount risponde 404
      if (updated.length) await upsertDiscovered(tx, account.id, models);
    });
    await sendAccount(res, account.id, UpdateAiAccountResponse);
  });

  router.delete("/ai/accounts/:id", async (req, res) => {
    const userId = currentUserId(req);
    const { id } = parseRequest(DeleteAiAccountParams, req.params);
    const account = await findWritableAccount(id, userId, res);
    if (!account) return;
    const usedBy = await usedByMessage(account.id);
    if (usedBy) {
      res.status(409).json({ error: usedBy });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const [deleted] = await tx.delete(aiAccountsTable).where(eq(aiAccountsTable.id, account.id)).returning();
        if (!deleted?.isDefault) return;
        // Era il predefinito: lo diventa l'account più vecchio rimasto
        const [oldest] = await tx
          .select({ id: aiAccountsTable.id })
          .from(aiAccountsTable)
          .where(eq(aiAccountsTable.userId, userId))
          .orderBy(asc(aiAccountsTable.createdAt), asc(aiAccountsTable.id))
          .limit(1);
        if (oldest) await tx.update(aiAccountsTable).set({ isDefault: true }).where(eq(aiAccountsTable.id, oldest.id));
      });
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
      // Un agente o un'analisi l'ha scelto nel frattempo
      res.status(409).json({ error: (await usedByMessage(account.id)) ?? "account in uso" });
      return;
    }
    res.status(204).end();
  });

  router.post("/ai/accounts/:id/verify", providerLimit, async (req, res) => {
    const { id } = parseRequest(VerifyAiAccountParams, req.params);
    const account = await findWritableAccount(id, currentUserId(req), res);
    if (!account) return;
    await verifyAccount(account);
    await sendAccount(res, account.id, VerifyAiAccountResponse);
  });

  router.post("/ai/accounts/:id/default", async (req, res) => {
    const userId = currentUserId(req);
    const { id } = parseRequest(SetDefaultAiAccountParams, req.params);
    const account = await findWritableAccount(id, userId, res);
    if (!account) return;
    await db.transaction(async (tx) => {
      await lockUser(tx, userId);
      await tx
        .update(aiAccountsTable)
        .set({ isDefault: false })
        .where(and(eq(aiAccountsTable.userId, userId), eq(aiAccountsTable.isDefault, true), ne(aiAccountsTable.id, account.id)));
      await tx.update(aiAccountsTable).set({ isDefault: true }).where(eq(aiAccountsTable.id, account.id));
    });
    await sendAccount(res, account.id, SetDefaultAiAccountResponse);
  });

  router.get("/ai/accounts/:id/models", async (req, res) => {
    const { id } = parseRequest(ListAiAccountModelsParams, req.params);
    const account = await findVisibleAccount(id, currentUserId(req));
    if (!account) {
      res.status(404).json({ error: ACCOUNT_NOT_FOUND });
      return;
    }
    const models = await db
      .select()
      .from(aiModelsTable)
      .where(eq(aiModelsTable.accountId, account.id))
      .orderBy(sql`lower(${aiModelsTable.displayName})`, asc(aiModelsTable.id));
    res.json(ListAiAccountModelsResponse.parse(models.map(toPublicModel)));
  });

  router.post("/ai/accounts/:id/models", async (req, res) => {
    const { id } = parseRequest(AddAiAccountModelParams, req.params);
    const body = parseRequest(AddAiAccountModelBody, req.body);
    const account = await findWritableAccount(id, currentUserId(req), res);
    if (!account) return;
    const modelId = body.modelId.trim();
    const displayName = body.displayName?.trim() || modelId;
    if (!modelId || CONTROL_RE.test(modelId) || CONTROL_RE.test(displayName)) {
      res.status(400).json({ error: BAD_MODEL_ID });
      return;
    }
    const hasPrice = body.priceInput != null || body.priceOutput != null;
    let created: AiModel | undefined;
    try {
      [created] = await db
        .insert(aiModelsTable)
        .values({
          accountId: account.id,
          modelId,
          displayName,
          contextTokens: body.contextTokens ?? null,
          priceInputPerMtok: toPrice(body.priceInput),
          priceOutputPerMtok: toPrice(body.priceOutput),
          priceSource: hasPrice ? "manual" : null,
          discovered: false,
        })
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err, "ai_models_account_model_unique")) throw err;
      res.status(409).json({ error: MODEL_EXISTS });
      return;
    }
    res.status(201).json(AddAiAccountModelResponse.parse(toPublicModel(created!)));
  });

  router.patch("/ai/models/:id", async (req, res) => {
    const userId = currentUserId(req);
    const { id } = parseRequest(UpdateAiModelParams, req.params);
    const body = parseRequest(UpdateAiModelBody, req.body);
    const [row] = await db
      .select({ model: aiModelsTable, account: aiAccountsTable })
      .from(aiModelsTable)
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(eq(aiModelsTable.id, id), visibleTo(userId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: MODEL_NOT_FOUND });
      return;
    }
    if (isSystemAccount(row.account)) {
      res.status(403).json({ error: SYSTEM_READONLY });
      return;
    }
    const set: Partial<typeof aiModelsTable.$inferInsert> = {};
    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim();
      if (!displayName || CONTROL_RE.test(displayName)) {
        res.status(400).json({ error: "nome del modello non valido" });
        return;
      }
      set.displayName = displayName;
    }
    if (body.hidden !== undefined) set.hidden = body.hidden;
    // Un prezzo indicato (anche null) è una scelta dell'utente: la verifica non lo sovrascrive più
    if (body.priceInput !== undefined) set.priceInputPerMtok = toPrice(body.priceInput);
    if (body.priceOutput !== undefined) set.priceOutputPerMtok = toPrice(body.priceOutput);
    if (body.priceInput !== undefined || body.priceOutput !== undefined) set.priceSource = "manual";

    let model = row.model;
    if (Object.keys(set).length) {
      [model] = (await db
        .update(aiModelsTable)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(aiModelsTable.id, id))
        .returning()) as [AiModel];
    }
    res.json(UpdateAiModelResponse.parse(toPublicModel(model)));
  });

  router.get("/ai/models", async (req, res) => {
    const accounts = await visibleAccountsSorted(currentUserId(req));
    const ids = accounts.map((a) => a.id);
    const models = ids.length
      ? await db
          .select()
          .from(aiModelsTable)
          .where(and(inArray(aiModelsTable.accountId, ids), eq(aiModelsTable.hidden, false)))
          .orderBy(sql`lower(${aiModelsTable.displayName})`, asc(aiModelsTable.id))
      : [];
    const counts = await modelCounts(ids);
    const groups = accounts.map((a) => ({
      account: toPublicAccount(a, counts.get(a.id) ?? 0),
      models: models.filter((m) => m.accountId === a.id).map(toPublicModel),
    }));
    res.json(ListAiModelsResponse.parse(groups));
  });

  router.get("/ai/estimate", async (req, res) => {
    const { aiModelId, maxTokens } = parseRequest(EstimateAnalysisCostQueryParams, req.query);
    const [row] = await db
      .select({ model: aiModelsTable })
      .from(aiModelsTable)
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(eq(aiModelsTable.id, aiModelId), visibleTo(currentUserId(req))))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: MODEL_NOT_FOUND });
      return;
    }
    const priceIn = toNumber(row.model.priceInputPerMtok);
    const priceOut = toNumber(row.model.priceOutputPerMtok);
    let estimate: { maxUsd: number | null; typicalUsd: number | null } = { maxUsd: null, typicalUsd: null };
    if (priceIn !== null && priceOut !== null) {
      // Si ipotizza il 95% di token di input; il tipico è il 60% del tetto
      const max = ((maxTokens ?? ANALYSIS_DEFAULT_MAX_TOKENS) * (0.95 * priceIn + 0.05 * priceOut)) / 1e6;
      estimate = { maxUsd: round4(max), typicalUsd: round4(0.6 * max) };
    }
    res.json(EstimateAnalysisCostResponse.parse(estimate));
  });

  return router;
}
