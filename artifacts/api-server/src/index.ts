import app from "./app";
import { logger } from "./lib/logger";
import { failInterruptedAnalyses } from "./lib/architect/run-analysis";
import { startLocalLeaseJob } from "./lib/architect/local-executor";
import { expireStalePausedRuns, failInterruptedRuns } from "./lib/run-executor";
import { failInterruptedPlanTurns } from "./lib/plan-chat/run-turn";
import { resetStaleIssueReservations } from "./lib/plan-issues/service";
import { ensureSystemAccount } from "./lib/ai/system-account";
import { failInterruptedCatalogRuns } from "./lib/catalog/refresh";
import { startCatalogScheduler } from "./lib/catalog/scheduler";
import { ensureProviderRegistry } from "./lib/catalog/provider-registry";
import { assertSecretKey } from "./lib/secrets";

// In produzione la chiave dei segreti è obbligatoria: meglio fallire all'avvio che alla prima cifratura.
if (process.env["NODE_ENV"] === "production") assertSecretKey();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Una sola istanza dell'API: le run ancora aperte all'avvio sono state interrotte dal riavvio.
failInterruptedRuns()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Run interrotte dal riavvio chiuse come fallite");
  })
  .catch((err: unknown) => logger.error({ err }, "Chiusura delle run interrotte non riuscita"));

// I turni della chat del piano rimasti in corso: la conversazione torna libera, con un messaggio d'errore.
failInterruptedPlanTurns()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Turni della chat del piano interrotti dal riavvio chiusi");
  })
  .catch((err: unknown) => logger.error({ err }, "Chiusura dei turni della chat del piano interrotti non riuscita"));

// Le voci prenotate per la creazione di un'issue (`creating` senza numero) quando l'API si è fermata.
resetStaleIssueReservations()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Prenotazioni di issue interrotte dal riavvio azzerate");
  })
  .catch((err: unknown) => logger.error({ err }, "Azzeramento delle prenotazioni di issue non riuscito"));

// Lo stesso vale per le analisi cloud dell'architetto in coda o in corso: diventano `interrupted`.
// Quelle locali restano: le esegue l'agente, e il job delle lease rimette in coda quelle abbandonate.
failInterruptedAnalyses()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Analisi rimaste aperte al riavvio segnate come interrotte");
  })
  .catch((err: unknown) => logger.error({ err }, "Chiusura delle analisi interrotte non riuscita"));

// Aggiornamenti del catalogo rimasti in corso: chiusi come falliti, poi parte il controllo settimanale.
failInterruptedCatalogRuns()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Aggiornamenti del catalogo interrotti dal riavvio chiusi come falliti");
  })
  .catch((err: unknown) =>
    logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura degli aggiornamenti del catalogo interrotti non riuscita"),
  )
  .finally(() => startCatalogScheduler());

// Registro dei provider allineato alla tabella providers, poi l'account AI di sistema dalle variabili del
// gateway attuale (collega agenti e analisi esistenti). Un errore non blocca l'avvio: si logga solo il nome,
// mai il messaggio.
ensureProviderRegistry()
  .catch((err: unknown) =>
    logger.error({ errorName: err instanceof Error ? err.name : "Error" }, "Allineamento del registro dei provider non riuscito"),
  )
  .then(() => ensureSystemAccount())
  .then((res) => {
    if (res) logger.info({ accountId: res.accountId }, "Account di sistema del gateway allineato");
  })
  .catch((err: unknown) =>
    logger.error({ errorName: err instanceof Error ? err.name : "Error" }, "Allineamento dell'account di sistema non riuscito"),
  );

startLocalLeaseJob();

// Le run in pausa senza conferma entro 10 minuti vengono annullate; il timer non tiene in vita il processo.
setInterval(() => {
  expireStalePausedRuns()
    .then((count) => {
      if (count > 0) logger.info({ count }, "Run in pausa scadute annullate");
    })
    .catch((err: unknown) => logger.error({ err }, "Scadenza delle run in pausa non riuscita"));
}, 60_000).unref();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
