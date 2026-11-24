// Registro delle azioni (issue #115): testi della console per gli eventi. Funzioni pure.

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Accesso",
  "github.link": "GitHub collegato",
  "github.unlink": "GitHub scollegato",
  "analysis_item.approve": "Voce dell'analisi approvata",
  "analysis_item.discard": "Voce dell'analisi scartata",
  "analysis_item.postpone": "Voce dell'analisi rimandata",
  "analysis_item.reopen": "Voce dell'analisi riaperta",
  "analysis_item.update": "Voce dell'analisi modificata",
  "pending_action.approve": "Voce di «Da confermare» approvata",
  "pending_action.reject": "Voce di «Da confermare» rifiutata",
  "plan_proposal.accept": "Scheda del piano accettata",
  "plan_proposal.reject": "Scheda del piano rifiutata",
  "team_chat_proposal.accept": "Scheda della squadra accettata",
  "team_chat_proposal.reject": "Scheda della squadra rifiutata",
  "character_proposal.accept": "Scheda di un personaggio accettata",
  "character_proposal.reject": "Scheda di un personaggio rifiutata",
  "character_instruction_proposal.accept": "Istruzioni personali proposte accettate",
  "character_instruction_proposal.reject": "Istruzioni personali proposte rifiutate",
  "api_token.create": "Token personale creato",
  "api_token.revoke": "Token personale revocato",
  "ai_account.create": "Account AI aggiunto",
  "ai_account.update": "Account AI modificato",
  "ai_account.delete": "Account AI eliminato",
  "ai_model.update": "Modello AI modificato",
  "budget.update": "Tetto di spesa modificato",
  "app.create": "App creata",
  "app.update": "App modificata",
  "app.delete": "App eliminata",
  "app.identity_secret.create": "Segreto d'identità generato",
  "app.identity_secret.delete": "Segreto d'identità tolto",
  "app.bug_settings.update": "Impostazioni delle segnalazioni modificate",
  "bug_report.close": "Segnalazione chiusa",
  "app_bootstrap.create": "Nuova app da zero richiesta",
  "agent.delete": "Agente eliminato",
  "app_tool.delete": "Tool eliminato",
  "trigger.secret.regenerate": "Indirizzo del webhook rigenerato",
  "trigger.signing_secret.update": "Segreto di firma del webhook cambiato",
  "trigger.delete": "Innesco eliminato",
  "node.create": "Nodo creato",
  "node.token.regenerate": "Token del nodo rigenerato",
  "node.disable": "Nodo disattivato",
  "node.uninstall_request": "Disinstallazione del nodo richiesta",
  "node.delete": "Nodo eliminato",
  "node_pairing.approve": "Mac collegato",
  "node_pairing.deny": "Collegamento di un Mac rifiutato",
  "oauth_grant.revoke": "App collegata revocata",
  "character_instructions.update": "Istruzioni personali salvate",
  "character_instructions.restore": "Istruzioni personali ripristinate",
  "evolution.save": "Ciclo di evoluzione salvato",
  "evolution.delete": "Ciclo di evoluzione eliminato",
  "evolution.stop": "Ciclo di evoluzione fermato",
  "evolution.resume": "Ciclo di evoluzione ripreso",
  "evolution.run_now": "Giro di evoluzione avviato",
  "team.activate": "Squadra attivata",
  "team.close": "Squadra chiusa",
  "team.budget.update": "Tetto della squadra modificato",
  "team_plan.update": "PLAN della squadra modificato",
};

const OBJECT_LABELS: Record<string, string> = {
  analysis_item: "voce",
  pending_action: "voce",
  plan_proposal: "scheda",
  team_chat_proposal: "scheda",
  character_proposal: "scheda",
  character_instruction_proposal: "scheda",
  api_token: "token",
  ai_account: "account",
  ai_model: "modello",
  app: "app",
  bug_report: "segnalazione",
  app_bootstrap: "richiesta",
  agent: "agente",
  app_tool: "tool",
  trigger: "innesco",
  node: "nodo",
  oauth_grant: "collegamento",
  character: "personaggio",
  team_instance: "squadra",
};

const VIA_LABELS: Record<string, string> = {
  session: "console",
  token: "token personale",
  embed: "pannello incorporato",
  mcp: "centralino (MCP)",
  alfred: "Alfred a voce",
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Oggetto dell'evento, es. «token #7» o «voce #12»; null senza oggetto. */
export function auditObjectLabel(objectType: string | null, objectId: string | null): string | null {
  if (!objectType && !objectId) return null;
  const label = objectType ? (OBJECT_LABELS[objectType] ?? objectType) : "oggetto";
  if (!objectId) return label;
  return objectType === "character" ? `${label} ${objectId}` : `${label} #${objectId}`;
}

export function auditViaLabel(via: string, tokenId: number | null): string {
  const label = VIA_LABELS[via] ?? via;
  return via === "token" && tokenId !== null ? `${label} #${tokenId}` : label;
}

const DETAIL_LABELS: Record<string, (v: unknown) => string | null> = {
  provider: (v) => (typeof v === "string" ? `con ${v === "github" ? "GitHub" : v === "google" ? "Google" : v}` : null),
  scopes: (v) => (Array.isArray(v) && v.length > 0 ? `ambiti ${v.join(", ")}` : null),
  status: (v) => (typeof v === "string" ? `esito ${v}` : null),
  kind: (v) => (typeof v === "string" ? `tipo ${v}` : null),
  excludedSteps: (v) => (typeof v === "number" ? `${v} passi esclusi` : null),
  keyChanged: (v) => (v === true ? "chiave cambiata" : null),
  serviceSecretChanged: (v) => (v === true ? "segreto di servizio cambiato" : null),
  sourceTokenChanged: (v) => (v === true ? "token del codice cambiato" : null),
  set: (v) => (v === true ? "impostato" : v === false ? "tolto" : null),
  replace: (v) => (v === true ? "al posto di un nodo esistente" : null),
};

/** Dettaglio leggibile su una riga (campi noti, gli altri ignorati). */
export function auditDetailText(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    const text = DETAIL_LABELS[key]?.(value);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
