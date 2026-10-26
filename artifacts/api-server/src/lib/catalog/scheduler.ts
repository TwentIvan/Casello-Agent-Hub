import { desc, inArray } from "drizzle-orm";
import { db, catalogRunsTable, modelOffersTable } from "@workspace/db";
import { logger } from "../logger";
import { CatalogBusyError, startCatalogRefresh } from "./refresh";

// Aggiornamento settimanale del catalogo nel processo dell'API: un controllo 5 minuti dopo l'avvio e
// poi ogni 24 ore; parte se l'ultimo aggiornamento concluso (completo o parziale) ha più di 7 giorni
// o se il catalogo è vuoto (es. una run della versione precedente conclusa dopo la migrazione).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 5 * 60 * 1000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Dovuto senza aggiornamenti conclusi o se l'ultimo ha più di 7 giorni. */
export function isWeeklyRefreshDue(lastFinishedAt: Date | null, now: Date): boolean {
  return lastFinishedAt === null || now.getTime() - lastFinishedAt.getTime() > WEEK_MS;
}

/** Avvia l'aggiornamento pianificato se è dovuto; true se l'ha avviato. Uno già in corso non è un errore. */
export async function checkWeeklyRefresh(now: Date = new Date(), start: typeof startCatalogRefresh = startCatalogRefresh): Promise<boolean> {
  const [anyOffer] = await db.select({ id: modelOffersTable.id }).from(modelOffersTable).limit(1);
  const [last] = await db
    .select({ finishedAt: catalogRunsTable.finishedAt })
    .from(catalogRunsTable)
    .where(inArray(catalogRunsTable.status, ["completed", "partial"]))
    .orderBy(desc(catalogRunsTable.finishedAt))
    .limit(1);
  if (anyOffer && !isWeeklyRefreshDue(last?.finishedAt ?? null, now)) return false;
  try {
    await start({ trigger: "scheduled", userId: null });
    return true;
  } catch (err) {
    if (err instanceof CatalogBusyError) return false;
    throw err;
  }
}

function tick(): void {
  checkWeeklyRefresh()
    .then((started) => {
      if (started) logger.info("Aggiornamento settimanale del catalogo avviato");
    })
    .catch((err: unknown) =>
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Controllo dell'aggiornamento del catalogo non riuscito"),
    );
}

/** Avvia i controlli periodici; i timer non tengono in vita il processo. */
export function startCatalogScheduler(): void {
  setTimeout(() => {
    tick();
    setInterval(tick, CHECK_EVERY_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
