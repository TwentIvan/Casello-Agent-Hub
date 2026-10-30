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
// qualsiasi modello. Il mese è quello di calendario, ora italiana. Un costo null (prezzo mancante) non si
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

/** Spesa del mese sugli account AI dell'utente: run, analisi e conversazioni del piano con un suo modello. */
export async function userSpend(userId: number, since: Date = monthStart()): Promise<Spend> {
  const owned = eq(aiAccountsTable.userId, userId);
  const [runs, analyses, chats] = await Promise.all([
    db
      .select({ spent: sumOf(runsTable.costUsd), unpriced: runUnpriced })
      .from(runsTable)
      .innerJoin(aiModelsTable, eq(runsTable.aiModelId, aiModelsTable.id))
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(owned, gte(runsTable.createdAt, since))),
    db
      .select({
        spent: sumOf(analysesTable.costUsd),
        unpriced: sql<number>`(count(*) filter (where ${analysesTable.costUsd} is null and ${analysesTable.tokensUsed} > 0))::int`,
      })
      .from(analysesTable)
      .innerJoin(aiModelsTable, eq(analysesTable.aiModelId, aiModelsTable.id))
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(owned, gte(analysesTable.createdAt, since))),
    // Il costo di una conversazione è cumulativo: conta nel mese dell'ultimo turno (per eccesso, così riprendere
    // una conversazione vecchia non aggira il tetto)
    db
      .select({
        spent: sumOf(planConversationsTable.costUsd),
        unpriced: sql<number>`(count(*) filter (where ${planConversationsTable.costUsd} is null and ${planConversationsTable.tokensUsed} > 0))::int`,
      })
      .from(planConversationsTable)
      .innerJoin(aiModelsTable, eq(planConversationsTable.aiModelId, aiModelsTable.id))
      .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
      .where(and(owned, gte(planConversationsTable.updatedAt, since))),
  ]);
  return toSpend([...runs, ...analyses, ...chats]);
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

/** Proprietario dell'account del modello; null per l'account di sistema o un modello assente. */
async function modelOwner(aiModelId: number | null): Promise<number | null> {
  if (aiModelId === null) return null;
  const [row] = await db
    .select({ userId: aiAccountsTable.userId })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  return row?.userId ?? null;
}

async function userCap(userId: number): Promise<number | null> {
  const [row] = await db
    .select({ cap: usersTable.monthlyBudgetUsd })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.cap == null ? null : Number(row.cap);
}

// Importi nei messaggi: due decimali con la virgola (5,20)
const usd = (n: number) => n.toFixed(2).replace(".", ",");

/** Il tetto è raggiunto quando la spesa nota lo eguaglia o lo supera (un tetto 0 blocca tutto). */
export function isExhausted(spentUsd: number, capUsd: number | null): boolean {
  return capUsd !== null && spentUsd >= capUsd;
}

/**
 * Motivo del blocco di un nuovo avvio che spende sul modello indicato, o null se si può partire. Conta il
 * tetto dell'utente che possiede l'account del modello (chi paga); l'account di sistema non ha tetto utente.
 */
export async function userBudgetBlock(aiModelId: number | null): Promise<string | null> {
  const owner = await modelOwner(aiModelId);
  if (owner === null) return null;
  const cap = await userCap(owner);
  if (cap === null) return null;
  const { spentUsd } = await userSpend(owner);
  if (!isExhausted(spentUsd, cap)) return null;
  return `Tetto di spesa mensile raggiunto: spesi ${usd(spentUsd)} su ${usd(cap)} USD. Alzalo nella pagina Account o attendi il mese prossimo.`;
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
  /** Run in corso o in attesa che spendono su un tetto già raggiunto (dell'utente o del loro agente). */
  activeRuns: ActiveRun[];
}

/** Riepilogo del mese per la console: tetto e spesa dell'utente, agenti con un tetto, run da poter fermare. */
export async function budgetSummary(userId: number, now: Date = new Date()): Promise<BudgetSummary> {
  const since = monthStart(now);
  const [cap, spend, capped] = await Promise.all([
    userCap(userId),
    userSpend(userId, since),
    db
      .select({ id: agentsTable.id, name: agentsTable.name, appId: agentsTable.appId, cap: agentsTable.monthlyBudgetUsd })
      .from(agentsTable)
      .where(isNotNull(agentsTable.monthlyBudgetUsd))
      .orderBy(asc(agentsTable.id)),
  ]);
  const spends = await agentSpends(
    capped.map((a) => a.id),
    since,
  );
  const agents: AgentBudget[] = capped.map((a) => ({
    agentId: a.id,
    agentName: a.name,
    appId: a.appId,
    capUsd: Number(a.cap),
    ...spends.get(a.id)!,
  }));

  const exhaustedAgentIds = agents.filter((a) => isExhausted(a.spentUsd, a.capUsd)).map((a) => a.agentId);
  const userExhausted = isExhausted(spend.spentUsd, cap);
  const scopes: SQL[] = [];
  if (userExhausted) scopes.push(eq(aiAccountsTable.userId, userId));
  if (exhaustedAgentIds.length) scopes.push(inArray(runsTable.agentId, exhaustedAgentIds));
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
    activeRuns: activeRuns as ActiveRun[],
  };
}
