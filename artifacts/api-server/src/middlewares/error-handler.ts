import type { ErrorRequestHandler } from "express";
import type { ZodError, ZodIssue } from "zod";
import { logger } from "../lib/logger";

// Gestore finale degli errori di /api: risposte sempre JSON `{ error }`.
// Body, parametri o query che non passano gli schemi Zod generati → 400 con il primo problema;
// ogni altro errore non gestito → 500 generico, registrato senza header della richiesta.

function isZodError(err: unknown): err is ZodError {
  return (
    err instanceof Error &&
    err.name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

function italianIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" ? "campo obbligatorio" : `tipo non valido (atteso ${issue.expected})`;
    case "invalid_enum_value":
      return `valore non ammesso (ammessi: ${issue.options.join(", ")})`;
    case "invalid_literal":
      return "valore non ammesso";
    case "unrecognized_keys":
      return `campi non previsti: ${issue.keys.join(", ")}`;
    case "too_small":
      return issue.type === "string" ? "testo troppo corto" : "valore troppo piccolo";
    case "too_big":
      return issue.type === "string" ? "testo troppo lungo" : "valore troppo grande";
    case "invalid_string":
      return "formato non valido";
    case "invalid_union":
      return "valore non valido";
    default:
      return "valore non valido";
  }
}

/** "richiesta non valida: <percorso>: <motivo>" sul primo problema dello schema. */
export function zodErrorMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "richiesta non valida";
  const path = issue.path.length ? issue.path.join(".") : "corpo";
  return `richiesta non valida: ${path}: ${italianIssue(issue)}`;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Risposta già iniziata: la chiude Express
  if (res.headersSent) {
    next(err);
    return;
  }
  if (isZodError(err)) {
    res.status(400).json({ error: zodErrorMessage(err) });
    return;
  }
  // JSON malformato nel body (express.json): errore del client, non del server
  const status = (err as { status?: unknown; type?: unknown }).status;
  if (status === 400 && (err as { type?: unknown }).type === "entity.parse.failed") {
    res.status(400).json({ error: "richiesta non valida: JSON del corpo malformato" });
    return;
  }
  // Solo metodo e percorso: mai header (X-App-User-Token) né body
  (req.log ?? logger).error(
    { err, method: req.method, url: req.originalUrl.split("?")[0] },
    "Errore non gestito nella richiesta",
  );
  res.status(500).json({ error: "Errore interno" });
};
