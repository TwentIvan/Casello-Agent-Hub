import { and, asc, eq, inArray } from "drizzle-orm";
import { db, aiAccountsTable, aiModelsTable, localMachinesTable, usersTable, type LocalMachine } from "@workspace/db";
import type { Tx } from "../ai/accounts";
import { newToken } from "./tokens";

/**
 * Macchine dell'agente locale. Ogni utente ha al più un account AI "Agente locale" (provider `local_agent`),
 * creato con la prima macchina e gestito solo da qui; ogni macchina è un suo modello (`machine-<id>`,
 * "Agente locale · <nome>"), selezionabile come gli altri finché la macchina non è revocata.
 */

export const LOCAL_PROVIDER = "local_agent";
const LOCAL_ACCOUNT_NAME = "Agente locale";
const LOCAL_BASE_URL = "local://";
/** Una macchina è "collegata" se il runner ha dato un segnale di vita entro questo tempo. */
export const CONNECTED_WINDOW_MS = 30_000;

const MODEL_ID_RE = /^machine-(\d+)$/;

export function machineModelId(machineId: number): string {
  return `machine-${machineId}`;
}

export function machineDisplayName(name: string): string {
  return `${LOCAL_ACCOUNT_NAME} · ${name}`;
}

/** Forma pubblica di una macchina: mai l'hash del token. */
export function toPublicMachine(m: LocalMachine, now = new Date()) {
  return {
    id: m.id,
    name: m.name,
    connected: m.revokedAt === null && m.lastSeenAt !== null && now.getTime() - m.lastSeenAt.getTime() < CONNECTED_WINDOW_MS,
    lastSeenAt: m.lastSeenAt,
    revokedAt: m.revokedAt,
  };
}

/** Account "Agente locale" dell'utente, creato se manca. La riga dell'utente bloccata serializza le creazioni. */
async function ensureLocalAccount(tx: Tx, userId: number): Promise<number> {
  await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
  const [existing] = await tx
    .select({ id: aiAccountsTable.id })
    .from(aiAccountsTable)
    .where(and(eq(aiAccountsTable.userId, userId), eq(aiAccountsTable.provider, LOCAL_PROVIDER)))
    .orderBy(asc(aiAccountsTable.id))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await tx
    .insert(aiAccountsTable)
    .values({
      userId,
      name: LOCAL_ACCOUNT_NAME,
      provider: LOCAL_PROVIDER,
      baseUrl: LOCAL_BASE_URL,
      apiKeyEnc: null,
      isDefault: false,
      status: "ok",
      lastCheckedAt: new Date(),
    })
    .returning({ id: aiAccountsTable.id });
  return created!.id;
}

/** Registra una macchina con il suo modello; il token in chiaro torna solo qui (salvato come hash). */
export async function registerMachine(userId: number, name: string): Promise<{ machine: LocalMachine; token: string }> {
  const { token, hash } = newToken("machine");
  const machine = await db.transaction(async (tx) => {
    const accountId = await ensureLocalAccount(tx, userId);
    const [row] = await tx.insert(localMachinesTable).values({ userId, name, tokenHash: hash }).returning();
    await tx.insert(aiModelsTable).values({
      accountId,
      modelId: machineModelId(row!.id),
      displayName: machineDisplayName(name),
      supportsTools: true,
      availability: "available",
      discovered: false,
    });
    return row!;
  });
  return { machine, token };
}

export async function listMachines(userId: number): Promise<LocalMachine[]> {
  return db
    .select()
    .from(localMachinesTable)
    .where(eq(localMachinesTable.userId, userId))
    .orderBy(asc(localMachinesTable.createdAt), asc(localMachinesTable.id));
}

/**
 * Revoca una macchina dell'utente e ne nasconde il modello. Già revocata: resta com'era (true).
 * False se non esiste o è di un altro utente.
 */
export async function revokeMachine(userId: number, machineId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [machine] = await tx
      .select()
      .from(localMachinesTable)
      .where(and(eq(localMachinesTable.id, machineId), eq(localMachinesTable.userId, userId)))
      .for("update");
    if (!machine) return false;
    if (machine.revokedAt === null) {
      await tx.update(localMachinesTable).set({ revokedAt: new Date() }).where(eq(localMachinesTable.id, machineId));
    }
    const accountIds = tx
      .select({ id: aiAccountsTable.id })
      .from(aiAccountsTable)
      .where(and(eq(aiAccountsTable.userId, userId), eq(aiAccountsTable.provider, LOCAL_PROVIDER)));
    await tx
      .update(aiModelsTable)
      .set({ hidden: true, updatedAt: new Date() })
      .where(and(eq(aiModelsTable.modelId, machineModelId(machineId)), inArray(aiModelsTable.accountId, accountIds)));
    return true;
  });
}

/** La macchina è dell'utente e non è revocata. */
export async function isMachineActive(machineId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ revokedAt: localMachinesTable.revokedAt })
    .from(localMachinesTable)
    .where(and(eq(localMachinesTable.id, machineId), eq(localMachinesTable.userId, userId)))
    .limit(1);
  return row !== undefined && row.revokedAt === null;
}

/** Modello dell'agente locale: la macchina che rappresenta; null per un modello API o inesistente. */
export async function isLocalModel(aiModelId: number): Promise<{ machineId: number } | null> {
  const [row] = await db
    .select({ modelId: aiModelsTable.modelId, provider: aiAccountsTable.provider })
    .from(aiModelsTable)
    .innerJoin(aiAccountsTable, eq(aiModelsTable.accountId, aiAccountsTable.id))
    .where(eq(aiModelsTable.id, aiModelId))
    .limit(1);
  if (!row || row.provider !== LOCAL_PROVIDER) return null;
  const m = MODEL_ID_RE.exec(row.modelId);
  return m ? { machineId: Number(m[1]) } : null;
}
