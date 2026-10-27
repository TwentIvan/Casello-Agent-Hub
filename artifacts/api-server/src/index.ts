import app from "./app";
import { logger } from "./lib/logger";
import { failInterruptedAnalyses } from "./lib/architect/run-analysis";
import { expireStalePausedRuns, failInterruptedRuns } from "./lib/run-executor";
import { ensureSystemAccount } from "./lib/ai/system-account";
import { failInterruptedCatalogRuns } from "./lib/catalog/refresh";
import { startCatalogScheduler } from "./lib/catalog/scheduler";
import { ensureProviderRegistry } from "./lib/catalog/provider-registry";
import { assertSecretKey } from "./lib/secrets";
import { expireLocalJobs, failOpenLocalJobs } from "./lib/local/jobs";

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

// Lo stesso vale per le analisi dell'architetto in coda o in corso: diventano `interrupted`.
failInterruptedAnalyses()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Analisi rimaste aperte al riavvio segnate come interrotte");
  })
  .catch((err: unknown) => logger.error({ err }, "Chiusura delle analisi interrotte non riuscita"));

// I lavori dell'agente locale aperti all'avvio sono orfani: chiusi come falliti (run e analisi collegate le
// chiudono i controlli sopra). Errori: solo il nome.
failOpenLocalJobs()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Lavori dell'agente locale interrotti dal riavvio chiusi come falliti");
  })
  .catch((err: unknown) =>
    logger.error({ errorName: err instanceof Error ? err.name : "Error" }, "Chiusura dei lavori dell'agente locale non riuscita"),
  );

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

// Le run in pausa senza conferma entro 10 minuti vengono annullate; il timer non tiene in vita il processo.
setInterval(() => {
  expireStalePausedRuns()
    .then((count) => {
      if (count > 0) logger.info({ count }, "Run in pausa scadute annullate");
    })
    .catch((err: unknown) => logger.error({ err }, "Scadenza delle run in pausa non riuscita"));
}, 60_000).unref();

// Lavori dell'agente locale col token scaduto (es. chat abbandonata): chiusi come falliti, ogni minuto.
setInterval(() => {
  expireLocalJobs()
    .then((count) => {
      if (count > 0) logger.info({ count }, "Lavori dell'agente locale scaduti chiusi");
    })
    .catch((err: unknown) =>
      logger.error({ errorName: err instanceof Error ? err.name : "Error" }, "Scadenza dei lavori dell'agente locale non riuscita"),
    );
}, 60_000).unref();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
