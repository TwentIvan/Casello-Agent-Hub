import { createHash } from "node:crypto";
import type { evolutionMergeModeEnum } from "@workspace/db";

// Consenso esplicito all'attivazione del ciclo (puro): testo mostrato, impronta e regola di rinnovo.

export const CONSENT_VERSION = "2026-11-16";

export type ConsentSettings = {
  mergeMode: (typeof evolutionMergeModeEnum.enumValues)[number];
  stagingBranch: string | null;
  teamTemplateId: number | null;
  analysisAiModelId: number;
  itemsPerRound: number;
  monthlyBudgetUsd: number;
};

/** SHA-256 esadecimale di un JSON con le chiavi sempre nello stesso ordine. */
export function consentHash(s: ConsentSettings): string {
  const canonical = JSON.stringify({
    version: CONSENT_VERSION,
    mergeMode: s.mergeMode,
    stagingBranch: s.stagingBranch,
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
    lines.push("Fa modificare il codice a una squadra e approva da solo il PLAN della squadra.");
    if (s.mergeMode === "direct") {
      lines.push(`Unisce da solo le PR su ${s.baseBranch}, con deploy in produzione.`);
    } else {
      lines.push(`Unisce le PR sul branch ${s.stagingBranch ?? "di prova"}, non su ${s.baseBranch}.`);
    }
  }
  lines.push(
    "Restano tue: le proposte di tool, agenti e skill, i merge di PR con script -post e le azioni L2 verso terzi.",
    `Il tetto di spesa mensile del ciclo è ${s.monthlyBudgetUsd} USD.`,
    "Attivi il ciclo a tuo rischio.",
  );
  return lines;
}

/** Serve un nuovo consenso se cambia qualcosa oltre al tetto, o se il tetto sale. */
export function consentRequired(prev: ConsentSettings | null, next: ConsentSettings): boolean {
  if (!prev) return true;
  if (
    prev.mergeMode !== next.mergeMode ||
    prev.stagingBranch !== next.stagingBranch ||
    prev.teamTemplateId !== next.teamTemplateId ||
    prev.analysisAiModelId !== next.analysisAiModelId ||
    prev.itemsPerRound !== next.itemsPerRound
  ) {
    return true;
  }
  return next.monthlyBudgetUsd > prev.monthlyBudgetUsd;
}
