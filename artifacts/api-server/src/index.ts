import app from "./app";
import { logger } from "./lib/logger";
import { failInterruptedAnalyses } from "./lib/architect/run-analysis";
import { startLocalLeaseJob } from "./lib/architect/local-executor";
import { startNodeSweeper, sweepNodeTasks } from "./lib/nodes/lease-sweeper";
import { failInterruptedNodeTurns, startNodeTurnSweeper } from "./lib/node-turns/sweeper";
import { startOAuthSweeper } from "./lib/oauth/grants";
import { ensureEmbedClients } from "./lib/embed/clients";
import { closeAllActiveSessions, startAlfredSweeper } from "./lib/alfred/sessions";
import { startMemorySweeper } from "./lib/memory/summaries";
import { startCodeCacheSweeper } from "./lib/code-reader/source-cache";
import { failInterruptedRuns } from "./lib/run-executor";
import { setOnRunSettled, startRunQueue } from "./lib/run-queue";
import { finalizeTriage } from "./lib/bugs/triage";
import { startBugSweeper } from "./lib/bugs/sweeper";
import { startBootstrapHealthChecker } from "./lib/app-bootstrap/health";
import { startTriggerPoller } from "./lib/triggers/poller";
import { failInterruptedArchitecture, startArchitectureScheduler } from "./lib/architecture/scheduler";
import { startCodeWatcher } from "./lib/code-writer/watcher";
import { startEvolutionScheduler } from "./lib/evolution/scheduler";
import { failInterruptedTeamWork } from "./lib/teams/task-runner";
import { pumpTurnInBackground, resumeQueuedTurns } from "./lib/teams/turn-runner";
import { setOnTurnQueued } from "./lib/teams/turn-queue";
import { failInterruptedActions } from "./lib/actions/decide";
import { failInterruptedBootstraps } from "./lib/app-bootstrap/service";
import { failInterruptedPlanTurns } from "./lib/plan-chat/run-turn";
import { failInterruptedTeamChatTurns } from "./lib/team-chat/run-turn";
import { failInterruptedCharacterTurns } from "./lib/characters/run-turn";
import { startStaleTurnSweeper } from "./lib/stale-turns";
import { resetStaleIssueReservations } from "./lib/plan-issues/service";
import { failInterruptedCatalogRuns } from "./lib/catalog/refresh";
import { startCatalogScheduler } from "./lib/catalog/scheduler";
import { ensureProviderRegistry } from "./lib/catalog/provider-registry";
import { assertSecretKey } from "./lib/secrets";
import { pool } from "@workspace/db";
import { runMigrations, MigrationError, errorCode } from "./lib/migrations/runner";
import { migrationsDir, migrationsDisabled } from "./lib/migrations/config";

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

// Migrazioni dello schema: prima di ogni pulizia dell'avvio (che leggono già le tabelle). Se una fallisce l'API non parte.
if (!migrationsDisabled()) {
  try {
    const { baselined, applied } = await runMigrations({ pool, dir: migrationsDir(), logger });
    logger.info({ baselined, applied }, "Migrazioni completate");
  } catch (err) {
    logger.error(
      {
        file: err instanceof MigrationError ? err.file : undefined,
        statement: err instanceof MigrationError ? err.statement : undefined,
        // Codice SQLSTATE o di sistema (ENOENT, ECONNREFUSED…) anche fuori da MigrationError; mai il messaggio
        code: err instanceof MigrationError ? err.code : errorCode(err),
        errName: err instanceof Error ? err.name : "unknown",
      },
      "Migrazioni non applicate: l'API non parte",
    );
    process.exit(1);
  }
}

// Una sola istanza dell'API: le run in corso all'avvio sono state interrotte dal riavvio; quelle in attesa
// restano in coda, tranne quelle partite con un token utente (solo in memoria, perso). Le run rimaste in
// pausa per conferma (meccanismo sostituito dalla coda delle azioni) diventano annullate. Poi parte lo
// scheduler della coda delle run (subito e ogni 30 s di riserva).
failInterruptedRuns()
  .then(({ failed, cancelled, userTokenLost }) => {
    if (failed > 0) logger.warn({ count: failed }, "Run interrotte dal riavvio chiuse come fallite");
    if (userTokenLost > 0) logger.warn({ count: userTokenLost }, "Run in coda con token utente perso al riavvio chiuse come fallite");
    if (cancelled > 0) logger.info({ count: cancelled }, "Run in pausa per conferma annullate: sostituite dalla coda delle azioni");
  })
  .catch((err: unknown) => logger.error({ err }, "Chiusura delle run interrotte non riuscita"))
  .finally(() => {
    startRunQueue();
    // Segnalazioni dei bug: vagli con la run chiusa altrove e voci di approvazione da riprovare, ogni 60 s.
    startBugSweeper();
    // Sorveglianza degli inneschi: dopo la coda delle run, che riceve le run create dai giri.
    startTriggerPoller();
    // Sintesi dell'architettura delle App: controllo dello SHA e rigenerazione, primo giro poco dopo l'avvio.
    startArchitectureScheduler();
    // Ciclo di evoluzione automatica: giri rimasti senza analisi viva chiusi, poi un controllo ogni 5 minuti.
    startEvolutionScheduler();
    // Sorveglianza della CI delle PR dei compiti con codice.
    startCodeWatcher();
    // App nate da zero: controllo di healthz sul loro dominio, primo giro dopo 60 s.
    startBootstrapHealthChecker();
  });

// Ogni motivo accodato fa partire il turno del capo della squadra (se nessun turno è in corso).
setOnTurnQueued(pumpTurnInBackground);

// Fine di ogni run avviata da questo processo: se è il vaglio di una segnalazione se ne applica l'esito.
setOnRunSettled(finalizeTriage);

// Turni del capo e compiti delle squadre rimasti in corso: falliti con evento `interrotto` e turno `restart`;
// poi ripartono i turni rimasti in coda delle squadre attive.
failInterruptedTeamWork()
  .catch((err: unknown) =>
    logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura del lavoro delle squadre interrotto non riuscita"),
  )
  .then(() => resumeQueuedTurns())
  .catch((err: unknown) =>
    logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Ripartenza dei turni delle squadre in coda non riuscita"),
  );

// Nascite di App da zero rimaste in corso: falliscono «interrotto dal riavvio» con la loro voce, PRIMA della chiusura
// generica delle azioni in esecuzione (che darebbe «esito incerto» senza il passo).
failInterruptedBootstraps()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Nuove app da zero interrotte dal riavvio segnate come fallite");
  })
  .catch((err: unknown) => logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura delle nuove app da zero interrotte non riuscita"))
  // Azioni in coda rimaste in esecuzione: l'esito è incerto (il servizio può averle eseguite).
  .then(() => failInterruptedActions())
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Azioni in coda interrotte dal riavvio segnate come fallite (esito incerto)");
  })
  .catch((err: unknown) => logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura delle azioni in coda interrotte non riuscita"));

// Turni delegati al nodo rimasti aperti: registro e token in memoria sono persi, falliscono `restart` (i chiamanti
// sono chiusi dalle loro pulizie); scadenze e pulizia oraria partono più sotto con `startNodeTurnSweeper`. Atteso
// PRIMA delle pulizie delle tre chat: chiudendo i turni interrotti, quelle fanno partire i messaggi in coda, che
// possono accodare un turno nuovo al nodo; se questa pulizia venisse dopo, chiuderebbe `restart` anche quel turno.
// Atteso anche prima di `listen`: un nodo che prende un turno subito dopo l'avvio non deve trovare un turno della vita precedente.
try {
  const count = await failInterruptedNodeTurns();
  if (count > 0) logger.warn({ count }, "Turni del nodo interrotti dal riavvio chiusi come falliti");
} catch (err) {
  logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dei turni del nodo interrotti non riuscita");
}

// Sintesi dell'architettura rimaste in corso: `error` «generazione interrotta dal riavvio», prima di `listen` e del primo giro.
try {
  await failInterruptedArchitecture();
} catch (err) {
  logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura delle sintesi dell'architettura interrotte non riuscita");
}

// I turni della chat del piano rimasti in corso: la conversazione torna libera, con un messaggio d'errore.
failInterruptedPlanTurns()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Turni della chat del piano interrotti dal riavvio chiusi");
  })
  .catch((err: unknown) => logger.error({ err }, "Chiusura dei turni della chat del piano interrotti non riuscita"));

// I turni della chat di squadra rimasti in corso: come quelli della chat del piano.
failInterruptedTeamChatTurns()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Turni della chat di squadra interrotti dal riavvio chiusi");
  })
  .catch((err: unknown) => logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dei turni della chat di squadra interrotti non riuscita"));

// I turni delle conversazioni di Alfred e Lucius rimasti in corso: come quelli della chat di squadra.
failInterruptedCharacterTurns()
  .then((count) => {
    if (count > 0) logger.warn({ count }, "Turni delle conversazioni dei personaggi interrotti dal riavvio chiusi");
  })
  .catch((err: unknown) => logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Chiusura dei turni delle conversazioni dei personaggi interrotti non riuscita"));

// Turni di chat rimasti appesi dopo l'avvio (deploy con due container accesi insieme): controllo ogni minuto.
startStaleTurnSweeper({
  plan: failInterruptedPlanTurns,
  character: failInterruptedCharacterTurns,
  team: failInterruptedTeamChatTurns,
});

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

// Registro dei provider allineato alla tabella providers. Un errore non blocca l'avvio: si logga solo il
// nome, mai il messaggio.
ensureProviderRegistry().catch((err: unknown) =>
  logger.error({ errorName: err instanceof Error ? err.name : "Error" }, "Allineamento del registro dei provider non riuscito"),
);

startLocalLeaseJob();

// Compiti presi dai nodi: lease scadute chiuse come fallite e avviso «nessun nodo adatto», all'avvio e ogni minuto.
void sweepNodeTasks();
startNodeSweeper();

startNodeTurnSweeper();

// Connettore OAuth: pulizia di codici, token, collegamenti revocati e client inutilizzati, all'avvio e ogni ora.
startOAuthSweeper();

// Plugin incorporabile: un client OAuth `embed` per ogni origine di EMBED_ALLOWED_ORIGINS. Un errore non blocca l'avvio.
ensureEmbedClients().catch((err: unknown) =>
  logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Allineamento dei client embed non riuscito"),
);

// Alfred: all'avvio le sessioni rimaste attive si chiudono; poi controllo ogni 5 minuti.
try {
  await closeAllActiveSessions();
} catch (err) {
  logger.error({ errName: err instanceof Error ? err.name : "Error" }, "Chiusura delle sessioni di Alfred non riuscita");
}
startAlfredSweeper();
startMemorySweeper();
startCodeCacheSweeper();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
