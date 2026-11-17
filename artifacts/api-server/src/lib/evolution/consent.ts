import { createHash } from "node:crypto";
import type { EvolutionCycle } from "@workspace/db";

// Consenso esplicito all'attivazione del ciclo (puro): testo mostrato, impronta, regola di rinnovo e validità.
// Dalla 3c `merge_mode` e il branch di prova del ciclo non decidono più nulla: «Porta in produzione» resta sempre all'utente
// e il branch di prova è un'impostazione dell'App (3b). Per questo non entrano nell'impronta né nel testo.

export const CONSENT_VERSION = "2026-11-17";

export type ConsentSettings = {
  teamTemplateId: number | null;
  analysisAiModelId: number;
  itemsPerRound: number;
  monthlyBudgetUsd: number;
};

/** SHA-256 esadecimale di un JSON con le chiavi sempre nello stesso ordine. */
export function consentHash(s: ConsentSettings): string {
  const canonical = JSON.stringify({
    version: CONSENT_VERSION,
    teamTemplateId: s.teamTemplateId,
    analysisAiModelId: s.analysisAiModelId,
    itemsPerRound: s.itemsPerRound,
    monthlyBudgetUsd: s.monthlyBudgetUsd,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Righe del dialogo di consenso: cosa fa Botcave da solo e cosa resta all'utente. */
export function consentText(s: ConsentSettings & { appName: string; baseBranch: string }): string[] {
  const lines = [
    `Botcave esegue da solo un'analisi di ${s.appName} a ogni giro, con la frequenza scelta.`,
    `Approva da solo fino a ${s.itemsPerRound} voci del piano per giro (capitoli completamento ed evoluzione).`,
  ];
  if (s.teamTemplateId !== null) {
    lines.push(
      "Crea una squadra dal modello scelto e le affida le voci di ogni giro.",
      "Approva da solo il PLAN della squadra e le sue modifiche.",
      "La squadra modifica il codice su un branch del lavoro: Botcave unisce da solo le PR dei compiti su quel branch quando la CI è verde.",
      "A fine lavoro Botcave riscrive il branch di prova dell'App con la testa del lavoro, se l'App ne ha uno.",
      `Portare il lavoro su ${s.baseBranch} (in produzione) resta sempre una tua decisione: la voce «Porta in produzione» in «Da confermare».`,
    );
  } else {
    lines.push("Senza modello di squadra le voci approvate restano nel piano: le fai realizzare tu con «Implementa».");
  }
  lines.push(
    "Restano tue: le proposte di tool, agenti e skill, i merge di PR con script -post fuori dal lavoro e le azioni L2 verso terzi.",
    `Il tetto di spesa mensile del ciclo è ${s.monthlyBudgetUsd} USD (analisi, squadra e compiti insieme).`,
    "Attivi il ciclo a tuo rischio.",
  );
  return lines;
}

/** Serve un nuovo consenso se cambia qualcosa oltre al tetto, o se il tetto sale. */
export function consentRequired(prev: ConsentSettings | null, next: ConsentSettings): boolean {
  if (!prev) return true;
  if (prev.teamTemplateId !== next.teamTemplateId || prev.analysisAiModelId !== next.analysisAiModelId || prev.itemsPerRound !== next.itemsPerRound) {
    return true;
  }
  return next.monthlyBudgetUsd > prev.monthlyBudgetUsd;
}

/** Impostazioni del ciclo coperte dal consenso; null senza modello dell'analisi (eliminato). */
export function settingsOf(cycle: EvolutionCycle): ConsentSettings | null {
  if (cycle.analysisAiModelId === null) return null;
  return {
    teamTemplateId: cycle.teamTemplateId,
    analysisAiModelId: cycle.analysisAiModelId,
    itemsPerRound: cycle.itemsPerRound,
    monthlyBudgetUsd: Number(cycle.monthlyBudgetUsd),
  };
}

/**
 * Consenso valido: dato da un utente ancora presente, con l'impronta delle impostazioni attuali. L'impronta contiene
 * CONSENT_VERSION: una versione nuova del testo invalida i consensi precedenti.
 */
export function consentValid(cycle: EvolutionCycle): boolean {
  const settings = settingsOf(cycle);
  return (
    cycle.consentAt !== null &&
    cycle.activatedBy !== null &&
    cycle.consentVersion === CONSENT_VERSION &&
    settings !== null &&
    cycle.consentHash === consentHash(settings)
  );
}
