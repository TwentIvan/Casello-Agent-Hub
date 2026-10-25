import app from "./app";
import { logger } from "./lib/logger";
import { failInterruptedRuns } from "./lib/run-executor";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
