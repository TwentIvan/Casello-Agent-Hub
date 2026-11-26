// Configurazione del collaudo: repository di collaudo e workflow fisso

import { isValidGithubRepo } from "../architect/sources";
import { logger } from "../logger";

/** Workflow fisso del repository di collaudo, lanciato con `workflow_dispatch`. */
export const COLLAUDO_WORKFLOW = "collaudo.yml";

/** Repository di collaudo (`COLLAUDO_REPO`, `owner/nome`), letto a ogni chiamata; null se manca o non è valido. */
export function collaudoRepo(): string | null {
  const value = process.env["COLLAUDO_REPO"]?.trim();
  if (!value) return null;
  if (!isValidGithubRepo(value)) {
    logger.warn({}, "COLLAUDO_REPO non valido: collaudo non configurato");
    return null;
  }
  return value;
}
