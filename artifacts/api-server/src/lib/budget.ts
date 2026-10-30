import { and, asc, eq, gte, inArray, isNotNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  db,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  planConversationsTable,
  runsTable,
  usersTable,
} from "@workspace/db";

// Tetti di spesa mensili (USD). Chi configura paga: la spesa di un utente è quella fatta sui suoi account AI
// (run, analisi cloud, chat del piano con un suo modello); quella di un agente è la somma delle sue run, con
// qualsiasi modello; quella di un modello o di un account AI è la stessa somma ristretta a quel modello o ai
// modelli dell'account (il credito si carica per chiave). Il mese è quello di calendario, ora italiana. Un costo null (prezzo mancante) non si
// può sommare: si conta a parte tra le esecuzioni senza prezzo, e la spesa reale è più alta di quella mostrata.

const TIME_ZONE = "Europe/Rome";

const ACTIVE_RUN_STATUSES = ["pending", "running", "awaiting_client"] as const;

export interface Spend {
  spentUsd: number;
  /** Esecuzioni con token consumati ma costo null (prezzo del modello mancante). */
  unpricedCount: number;
}

/** Anno e mese (1-12) di un istante nel fuso di Roma. */
function romeYearMonth(at: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "numeric" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month") };
}

/**
 * Inizio del mese corrente a Roma, come istante. La mezzanotte del primo del mese non cade mai in un cambio
 * d'ora (che avviene l'ultima domenica di marzo e di ottobre alle 2-3), quindi basta provare +1 e +2.
 */
export function monthStart(now: Date = new Date()): Date {
  const { year, month } = romeYearMonth(now);
  for (const offsetHours of [1, 2]) {
    const candidate = new Date(Date.UTC(year, month - 1, 1, -offsetHours));
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(candidate);
    if (Number(hour) === 0) return candidate;
  }
  throw new Error("Inizio del mese non calcolabile");
}

/** Mese corrente come "AAAA-MM" (ora italiana). */
export function monthLabel(now: Date = new Date()): string {
  const { year, month } = romeYearMonth(now);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function sumOf(cost: SQLWrapper) {
  return sql<string>`coalesce(sum(${cost}), 0)`;
}

function toSpend(rows: { spent: string; unpriced: number }[]): Spend {
  return rows.reduce<Spend>(
    (acc, r) => ({ spentUsd: acc.spentUsd + Number(r.spent), unpricedCount: acc.unpricedCount + r.unpriced }),
    { spentUsd: 0, unpricedCount: 0 },
  );
}

const runUnpriced = sql<number>`(count(*) filter (where ${runsTable.costUsd} is null and coalesce(${runsTable.promptTokens}, 0) + coalesce(${runsTable.completionTokens}, 0) > 0))::int`;

/** Chiave per cui raggruppare la spesa sui modelli degli account: utente proprietario, account o modello. */
type SpendKey = typeof aiAccountsTable.userId | typeof aiModelsTable.accountId | typeof aiModelsTable.id;

/**
 * Spesa del mese sui modelli degli account AI, raggruppata per `key` e limitata a `ids`: run, analisi cloud e
 * conversazioni del piano fatte con quei modelli. Ogni id richiesto compare nel risultato (spesa 0 se non ce n'è).
 */
async function spendsBy(key: SpendKey, ids: number[], since: Date): Promise<Map<number, Spend>> {
  const result = new Map<number, Spend>(ids.map((id) => [id, { spentUsd: 0, unpricedCount: 0 }]));
  if (ids.length === 0) return result;
  const scope = inArray(key, ids);
  const [runs, analyses, chats] = await Promise.all([
    db
      .select({ key, spent: sumOf(runsTable.costUsd), unpriced: runUnpriced })
      .from(runsTable)
      .innerJoin(aiModelsTable, eq(runsTable.aiModelId, aiModelsTable.id))
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(scope, gte(runsTable.createdAt, since)))
      .groupBy(key),
    db
      .select({
        key,
        spent: sumOf(analysesTable.costUsd),
        unpriced: sql<number>`(count(*) filter (where ${analysesTable.costUsd} is null and ${analysesTable.tokensUsed} > 0))::int`,
      })
      .from(analysesTable)
      .innerJoin(aiModelsTable, eq(analysesTable.aiModelId, aiModelsTable.id))
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(scope, gte(analysesTable.createdAt, since)))
      .groupBy(key),
    // Il costo di una conversazione è cumulativo: conta nel mese dell'ultimo turno (per eccesso, così riprendere
    // una conversazione vecchia non aggira il tetto)
    db
      .select({
        key,
        spent: sumOf(planConversationsTable.costUsd),
        unpriced: sql<number>`(count(*) filter (where ${planConversationsTable.costUsd} is null and ${planConversationsTable.tokensUsed} > 0))::int`,
      })
      .from(planConversationsTable)
      .innerJoin(aiModelsTable, eq(planConversationsTable.aiModelId, aiModelsTable.id))
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(scope, gte(planConversationsTable.updatedAt, since)))
      .groupBy(key),
  ]);
  for (const r of [...runs, ...analyses, ...chats]) {
    if (r.key === null) continue;
    const acc = result.get(r.key)!;
    result.set(r.key, { spentUsd: acc.spentUsd + Number(r.spent), unpricedCount: acc.unpricedCount + r.unpriced });
  }
  return result;
}

/** Spesa del mese sugli account AI dell'utente: run, analisi e conversazioni del piano con un suo modello. */
export async function userSpend(userId: number, since: Date = monthStart()): Promise<Spend> {
  return (await spendsBy(aiAccountsTable.userId, [userId], since)).get(userId)!;
}

/** Spesa del mese su ciascun account AI (tutti i suoi modelli). */
export function accountSpends(accountIds: number[], since: Date = monthStart()): Promise<Map<number, Spend>> {
  return spendsBy(aiModelsTable.accountId, accountIds, since);
}

/** Spesa del mese su ciascun modello AI. */
export function modelSpends(aiModelIds: number[], since: Date = monthStart()): Promise<Map<number, Spend>> {
  return spendsBy(aiModelsTable.id, aiModelIds, since);
}

/** Spesa del mese delle run di ciascun agente (tutti i modelli). */
export async function agentSpends(agentIds: number[], since: Date = monthStart()): Promise<Map<number, Spend>> {
  const result = new Map<number, Spend>(agentIds.map((id) => [id, { spentUsd: 0, unpricedCount: 0 }]));
  if (agentIds.length === 0) return result;
  const rows = await db
    .select({ agentId: runsTable.agentId, spent: sumOf(runsTable.costUsd), unpriced: runUnpriced })
    .from(runsTable)
    .where(and(inArray(runsTable.agentId, agentIds), gte(runsTable.createdAt, since)))
    .groupBy(runsTable.agentId);
  for (const r of rows) result.set(r.agentId, toSpend([r]));
  return result;
}

/** Modello con il suo account e i rispettivi tetti; undefined se il modello non esiste. */
async function modelWithAccount(aiModelId: number) {
  const [row] = await db
    .select({
      modelName: aiModelsTable.displayName,
      modelCap: aiModelsTable.monthlyBudgetUsd,
      accountId: aiAccountsTable.id,
      accountName: aiAccountsTable.name,
      accountCap: aiAccountsTable.monthlyBudgetUsd,
      userId: aiAccountsTable.userId,
    })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  return row;
}

async function userCap(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ cap: usersTable.monthlyBudgetUsd })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.cap == null ? null : Number(row.cap);
}

/** Tetto in USD → colonna numeric, arrotondato al centesimo; null = nessun limite. */
export function budgetColumn(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

// Importi nei messaggi: due decimali con la virgola (5,20)
const usd = (n: number) => n.toFixed(2).replace(".", ",");

/** Il tetto è raggiunto quando la spesa nota lo eguaglia o lo supera (un tetto 0 blocca tutto). */
export function isExhausted(spentUsd: number, capUsd: number | null): boolean {
  return capUsd !== null && spentUsd >= capUsd;
}

const RAISE_IN_ACCOUNT = "Alzalo nella pagina Account o attendi il mese prossimo.";

/**
 * Motivo del blocco di un nuovo avvio che spende sul modello indicato, o null se si può partire. Controlla, in
 * ordine, il tetto del modello, quello del suo account AI e quello dell'utente che possiede l'account (chi paga).
 * L'account di sistema non ha tetti.
 */
export async function userBudgetBlock(aiModelId: number | null): Promise<string | null> {
  if (aiModelId === null) return null;
  const row = await modelWithAccount(aiModelId);
  if (!row || row.userId === null) return null;
  if (row.modelCap !== null) {
    const cap = Number(row.modelCap);
    const { spentUsd } = (await modelSpends([aiModelId])).get(aiModelId)!;
    if (isExhausted(spentUsd, cap)) {
      return `Tetto di spesa mensile del modello "${row.modelName}" raggiunto: spesi ${usd(spentUsd)} su ${usd(cap)} USD. ${RAISE_IN_ACCOUNT}`;
    }
  }
  if (row.accountCap !== null) {
    const cap = Number(row.accountCap);
    const { spentUsd } = (await accountSpends([row.accountId])).get(row.accountId)!;
    if (isExhausted(spentUsd, cap)) {
      return `Tetto di spesa mensile dell'account AI "${row.accountName}" raggiunto: spesi ${usd(spentUsd)} su ${usd(cap)} USD. ${RAISE_IN_ACCOUNT}`;
    }
  }
  const cap = await userCap(row.userId);
  if (cap === null) return null;
  const { spentUsd } = await userSpend(row.userId);
  if (!isExhausted(spentUsd, cap)) return null;
  return `Tetto di spesa mensile raggiunto: spesi ${usd(spentUsd)} su ${usd(cap)} USD. ${RAISE_IN_ACCOUNT}`;
}

/** Motivo del blocco di una nuova run dell'agente: prima il tetto dell'agente, poi quello di chi paga il modello. */
export async function runBudgetBlock(agent: {
  id: number;
  aiModelId: number | null;
  monthlyBudgetUsd: string | null;
}): Promise<string | null> {
  if (agent.monthlyBudgetUsd !== null) {
    const cap = Number(agent.monthlyBudgetUsd);
    const { spentUsd } = (await agentSpends([agent.id])).get(agent.id)!;
    if (isExhausted(spentUsd, cap)) {
      return `Tetto di spesa mensile dell'agente raggiunto: spesi ${usd(spentUsd)} su ${usd(cap)} USD. Alzalo nella scheda dell'agente o attendi il mese prossimo.`;
    }
  }
  return userBudgetBlock(agent.aiModelId);
}

export interface AgentBudget extends Spend {
  agentId: number;
  agentName: string;
  appId: number;
  capUsd: number;
}

export interface AccountBudget extends Spend {
  accountId: number;
  accountName: string;
  capUsd: number;
}

export interface ModelBudget extends Spend {
  aiModelId: number;
  modelName: string;
  accountId: number;
  accountName: string;
  capUsd: number;
}

export interface ActiveRun {
  id: number;
  agentId: number;
  agentName: string;
  status: (typeof ACTIVE_RUN_STATUSES)[number];
}

export interface BudgetSummary {
  month: string;
  user: Spend & { capUsd: number | null };
  agents: AgentBudget[];
  /** Account AI dell'utente con un tetto. */
  accounts: AccountBudget[];
  /** Modelli degli account dell'utente con un tetto. */
  models: ModelBudget[];
  /** Run in corso o in attesa che spendono su un tetto già raggiunto (dell'utente, dell'agente, del modello o dell'account). */
  activeRuns: ActiveRun[];
}

/**
 * Riepilogo del mese per la console: tetto e spesa dell'utente, agenti, account e modelli con un tetto, run da
 * poter fermare.
 */
export async function budgetSummary(userId: number, now: Date = new Date()): Promise<BudgetSummary> {
  const since = monthStart(now);
  const owned = eq(aiAccountsTable.userId, userId);
  const [cap, spend, capped, cappedAccounts, cappedModels] = await Promise.all([
    userCap(userId),
    userSpend(userId, since),
    db
      .select({ id: agentsTable.id, name: agentsTable.name, appId: agentsTable.appId, cap: agentsTable.monthlyBudgetUsd })
      .from(agentsTable)
      .where(isNotNull(agentsTable.monthlyBudgetUsd))
      .orderBy(asc(agentsTable.id)),
    db
      .select({ id: aiAccountsTable.id, name: aiAccountsTable.name, cap: aiAccountsTable.monthlyBudgetUsd })
      .from(aiAccountsTable)
      .where(and(owned, isNotNull(aiAccountsTable.monthlyBudgetUsd)))
      .orderBy(asc(aiAccountsTable.id)),
    db
      .select({
        id: aiModelsTable.id,
        name: aiModelsTable.displayName,
        accountId: aiAccountsTable.id,
        accountName: aiAccountsTable.name,
        cap: aiModelsTable.monthlyBudgetUsd,
      })
      .from(aiModelsTable)
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(owned, isNotNull(aiModelsTable.monthlyBudgetUsd)))
      .orderBy(asc(aiModelsTable.id)),
  ]);
  const [spends, accountSpent, modelSpent] = await Promise.all([
    agentSpends(
      capped.map((a) => a.id),
      since,
    ),
    accountSpends(
      cappedAccounts.map((a) => a.id),
      since,
    ),
    modelSpends(
      cappedModels.map((m) => m.id),
      since,
    ),
  ]);
  const agents: AgentBudget[] = capped.map((a) => ({
    agentId: a.id,
    agentName: a.name,
    appId: a.appId,
    capUsd: Number(a.cap),
    ...spends.get(a.id)!,
  }));

  const accounts: AccountBudget[] = cappedAccounts.map((a) => ({
    accountId: a.id,
    accountName: a.name,
    capUsd: Number(a.cap),
    ...accountSpent.get(a.id)!,
  }));
  const models: ModelBudget[] = cappedModels.map((m) => ({
    aiModelId: m.id,
    modelName: m.name,
    accountId: m.accountId,
    accountName: m.accountName,
    capUsd: Number(m.cap),
    ...modelSpent.get(m.id)!,
  }));

  const exhaustedAgentIds = agents.filter((a) => isExhausted(a.spentUsd, a.capUsd)).map((a) => a.agentId);
  const exhaustedAccountIds = accounts.filter((a) => isExhausted(a.spentUsd, a.capUsd)).map((a) => a.accountId);
  const exhaustedModelIds = models.filter((m) => isExhausted(m.spentUsd, m.capUsd)).map((m) => m.aiModelId);
  const userExhausted = isExhausted(spend.spentUsd, cap);
  const scopes: SQL[] = [];
  if (userExhausted) scopes.push(owned);
  if (exhaustedAgentIds.length) scopes.push(inArray(runsTable.agentId, exhaustedAgentIds));
  if (exhaustedAccountIds.length) scopes.push(inArray(aiAccountsTable.id, exhaustedAccountIds));
  if (exhaustedModelIds.length) scopes.push(inArray(runsTable.aiModelId, exhaustedModelIds));
  const activeRuns = scopes.length
    ? await db
        .select({ id: runsTable.id, agentId: runsTable.agentId, agentName: agentsTable.name, status: runsTable.status })
        .from(runsTable)
        .innerJoin(agentsTable, eq(runsTable.agentId, agentsTable.id))
        .leftJoin(aiModelsTable, eq(runsTable.aiModelId, aiModelsTable.id))
        .leftJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
        .where(and(inArray(runsTable.status, [...ACTIVE_RUN_STATUSES]), or(...scopes)))
        .orderBy(asc(runsTable.id))
    : [];

  return {
    month: monthLabel(now),
    user: { capUsd: cap, ...spend },
    agents,
    accounts,
    models,
    activeRuns: activeRuns as ActiveRun[],
  };
}
