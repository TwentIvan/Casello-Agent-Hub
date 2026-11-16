// Schedulatore della sintesi dell'architettura: un giro ogni 30 minuti, uno alla volta; ogni giro controlla lo SHA
// di al più 20 App idonee (le meno recenti per `checked_at`, mai controllate prima) con al più 2 App in parallelo.
// La logica sta in `service.ts`. Nei log solo conteggi ed esito.

import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, agentsTable, appArchitectureTable, appsTable } from "@workspace/db";
import { logger } from "../logger";
import { checkApp } from "./service";

export {
  ARCH_VERSIONS_KEPT,
  REFRESH_INTERVAL_MS,
  architectureEligibility,
  backoffMs,
  checkApp,
  claimGeneration,
  failInterruptedArchitecture,
  generateForApp,
  isDue,
  requestArchitectureRefresh,
  waitArchitectureIdleForTests,
  type Eligibility,
} from "./service";

export const ARCH_CHECK_MS = 1_800_000;
/** Primo giro poco dopo l'avvio: con deploy frequenti l'intervallo da solo non arriverebbe mai. */
const ARCH_FIRST_CHECK_MS = 60_000;
export const ARCH_APPS_PER_ROUND = 20;
export const ARCH_PARALLEL = 2;

/** Un giro: App idonee (frequenza ≠ off, GitHub tramite installazione, Responsabile attivo con modello). Risponde quante. */
export async function runArchitectureRound(): Promise<number> {
  const apps = await db
    .select({ app: appsTable })
    .from(appsTable)
    .leftJoin(appArchitectureTable, eq(appArchitectureTable.appId, appsTable.id))
    .where(
      and(
        ne(appsTable.architectureRefresh, "off"),
        eq(appsTable.sourceType, "github"),
        isNotNull(appsTable.sourceRepo),
        isNotNull(appsTable.sourceInstallationId),
        sql`exists (select 1 from ${agentsTable} where ${agentsTable.appId} = ${appsTable.id} and ${agentsTable.role} = 'general' and ${agentsTable.status} = 'active' and ${agentsTable.aiModelId} is not null)`,
      ),
    )
    .orderBy(sql`${appArchitectureTable.checkedAt} asc nulls first`, asc(appsTable.id))
    .limit(ARCH_APPS_PER_ROUND);

  const queue = apps.map((r) => r.app);
  const worker = async () => {
    for (let app = queue.shift(); app; app = queue.shift()) {
      try {
        await checkApp(app);
      } catch (err) {
        logger.error({ appId: app.id, errName: err instanceof Error ? err.name : "Error" }, "Controllo dell'architettura non riuscito");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARCH_PARALLEL, queue.length) }, worker));
  return apps.length;
}

/** Avvia il giro periodico; risponde con la funzione che lo ferma. */
export function startArchitectureScheduler(): () => void {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const count = await runArchitectureRound();
      if (count > 0) logger.info({ count }, "Giro della sintesi dell'architettura concluso");
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Giro della sintesi dell'architettura non riuscito");
    } finally {
      checking = false;
    }
  };
  const first = setTimeout(() => void check(), ARCH_FIRST_CHECK_MS);
  const timer = setInterval(() => void check(), ARCH_CHECK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
