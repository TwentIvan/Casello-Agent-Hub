import type { Analysis, App } from "@workspace/api-client-react";

/** La rianalisi automatica ha effetto solo con il codice da GitHub tramite l'installazione dell'App GitHub. */
export function autoReanalysisAvailable(app: Pick<App, "sourceType" | "sourceRepo" | "sourceInstallationId">): boolean {
  return app.sourceType === "github" && !!app.sourceRepo && app.sourceInstallationId != null;
}

/** Etichetta dell'analisi avviata dalla rianalisi automatica (null = avviata a mano). */
export function autoReanalysisLabel(analysis: Pick<Analysis, "triggerCommit">): string | null {
  return analysis.triggerCommit ? `automatica · commit ${analysis.triggerCommit.slice(0, 7)}` : null;
}
