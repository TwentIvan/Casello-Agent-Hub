import { and, eq, isNull } from "drizzle-orm";
import { db, appBootstrapsTable } from "@workspace/db";
import { logger } from "../logger";
import { fetchPage, type WebFetcher } from "../web-reader/fetch-page";

const HEALTH_CHECK_MS = 10 * 60_000;
const FIRST_CHECK_MS = 60_000;
const PER_PASS = 20;

/** Controlla https://<dominio>/api/healthz: `healthCheckedAt` sempre, `healthOkAt` solo se risponde. */
export async function checkHealth(id: number, fetcher: WebFetcher = fetchPage): Promise<boolean> {
  const [row] = await db.select({ domain: appBootstrapsTable.domain }).from(appBootstrapsTable).where(eq(appBootstrapsTable.id, id)).limit(1);
  if (!row) return false;
  let ok = false;
  try {
    ok = (await fetcher(`https://${row.domain}/api/healthz`)).ok;
  } catch {
    ok = false;
  }
  const now = new Date();
  await db
    .update(appBootstrapsTable)
    .set(ok ? { healthOkAt: now, healthCheckedAt: now, updatedAt: now } : { healthCheckedAt: now, updatedAt: now })
    .where(eq(appBootstrapsTable.id, id));
  return ok;
}

let running = false;

/** Un giro: le richieste `done` ancora senza esito positivo, al più 20, una alla volta. */
export async function runHealthPass(fetcher: WebFetcher = fetchPage): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await db
      .select({ id: appBootstrapsTable.id })
      .from(appBootstrapsTable)
      .where(and(eq(appBootstrapsTable.status, "done"), isNull(appBootstrapsTable.healthOkAt)))
      .orderBy(appBootstrapsTable.healthCheckedAt)
      .limit(PER_PASS);
    for (const r of rows) await checkHealth(r.id, fetcher);
  } catch (err) {
    logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Controllo di healthz delle app da zero non riuscito");
  } finally {
    running = false;
  }
}

/** Primo giro dopo 60 s, poi ogni 10 minuti. */
export function startBootstrapHealthChecker(): void {
  setTimeout(() => {
    void runHealthPass();
    setInterval(() => void runHealthPass(), HEALTH_CHECK_MS).unref();
  }, FIRST_CHECK_MS).unref();
}
