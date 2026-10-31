import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/** Campi oscurati in ogni riga di log (esportati per il test dei log dei token). */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  // Chiavi dei provider (es. un ResolvedModel finito per errore in un log)
  "apiKey",
  "*.apiKey",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: LOG_REDACT_PATHS,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
