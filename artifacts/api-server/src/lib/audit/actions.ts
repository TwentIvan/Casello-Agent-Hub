// Registro delle azioni (issue #115): quali route sensibili lasciano un evento e con quali dati.
// Funzioni pure: nessun accesso al DB. Il dettaglio contiene solo valori scelti qui (enum, conteggi, id, booleani),
// mai il corpo della richiesta né la risposta: segreti, token, argomenti e testi dell'utente non entrano mai.

export type AuditDetailValue = string | number | boolean | null | string[];
export type AuditDetail = Record<string, AuditDetailValue>;

export interface AuditExtractInput {
  /** Gruppi catturati dal percorso (id e simili), in ordine */
  params: string[];
  /** Corpo della richiesta già letto dal parser (non validato: si leggono solo campi noti) */
  body: unknown;
  /** Risposta JSON della route (solo per leggere l'id creato; non si salva mai) */
  payload: unknown;
}

export interface AuditExtract {
  action?: string;
  objectId?: string | number | null;
  detail?: AuditDetail;
}

export interface AuditRoute {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: RegExp;
  action: string;
  objectType: string | null;
  extract?: (input: AuditExtractInput) => AuditExtract;
}

function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

/** Valore tra quelli ammessi, altrimenti null: un testo libero non entra mai nel dettaglio. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function idOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const DECISION = ["accept", "reject"] as const;
const ITEM_STATUS = ["approved", "discarded", "postponed", "pending"] as const;
const ITEM_ACTION = { approved: "approve", discarded: "discard", postponed: "postpone", pending: "reopen" } as const;
const ACTION_KINDS = ["action", "plan", "plan_change", "proposal", "merge", "bug", "release", "app_bootstrap"] as const;
const ACTION_STATUS = ["pending", "executing", "done", "failed", "rejected"] as const;
const TOKEN_SCOPES = ["mcp", "api:read", "api:write", "runs", "agent"] as const;

function proposalDecision(prefix: string) {
  return ({ body }: AuditExtractInput): AuditExtract => {
    const d = oneOf(field(body, "action"), DECISION);
    return d ? { action: `${prefix}.${d}` } : {};
  };
}

function pendingActionOutcome({ params, body, payload }: AuditExtractInput): AuditExtract {
  const excluded = field(body, "escludi");
  return {
    objectId: params[0] ?? null,
    detail: {
      kind: oneOf(field(payload, "kind"), ACTION_KINDS),
      status: oneOf(field(payload, "status"), ACTION_STATUS),
      ...(Array.isArray(excluded) && excluded.length > 0 ? { excludedSteps: excluded.length } : {}),
    },
  };
}

const n = String.raw`(\d+)`;
const re = (path: string) => new RegExp(`^${path}/?$`);

/** Route che lasciano un evento quando rispondono 2xx. Percorsi relativi a /api. */
export const AUDIT_ROUTES: AuditRoute[] = [
  // Architetto: revisione delle voci (approvare applica tool, agenti e skill)
  {
    method: "PATCH",
    pattern: re(`/analysis-items/${n}`),
    action: "analysis_item.update",
    objectType: "analysis_item",
    extract: ({ body }) => {
      const status = oneOf(field(body, "status"), ITEM_STATUS);
      return status ? { action: `analysis_item.${ITEM_ACTION[status]}` } : {};
    },
  },
  // Coda delle conferme
  { method: "POST", pattern: re(`/pending-actions/${n}/approve`), action: "pending_action.approve", objectType: "pending_action", extract: pendingActionOutcome },
  { method: "POST", pattern: re(`/pending-actions/${n}/reject`), action: "pending_action.reject", objectType: "pending_action", extract: pendingActionOutcome },
  // Schede dei bot accettate o rifiutate
  { method: "POST", pattern: re(`/plan-proposals/${n}/decision`), action: "plan_proposal.decide", objectType: "plan_proposal", extract: proposalDecision("plan_proposal") },
  { method: "POST", pattern: re(`/team-chat-proposals/${n}/decision`), action: "team_chat_proposal.decide", objectType: "team_chat_proposal", extract: proposalDecision("team_chat_proposal") },
  { method: "POST", pattern: re(`/character-proposals/${n}/decision`), action: "character_proposal.decide", objectType: "character_proposal", extract: proposalDecision("character_proposal") },
  {
    method: "POST",
    pattern: re(`/character-instruction-proposals/${n}/decision`),
    action: "character_instruction_proposal.decide",
    objectType: "character_instruction_proposal",
    extract: proposalDecision("character_instruction_proposal"),
  },
  // Token personali
  {
    method: "POST",
    pattern: re("/account/tokens"),
    action: "api_token.create",
    objectType: "api_token",
    extract: ({ body, payload }) => {
      const scopes = field(body, "scopes");
      return {
        objectId: idOf(field(field(payload, "info"), "id")),
        detail: { scopes: Array.isArray(scopes) ? scopes.filter((s) => oneOf(s, TOKEN_SCOPES)).map(String) : ["mcp"] },
      };
    },
  },
  { method: "DELETE", pattern: re(`/account/tokens/${n}`), action: "api_token.revoke", objectType: "api_token" },
  // Account AI (chiavi) e modelli (prezzi, tetti)
  {
    method: "POST",
    pattern: re("/ai/accounts"),
    action: "ai_account.create",
    objectType: "ai_account",
    extract: ({ payload }) => ({ objectId: idOf(field(payload, "id")) }),
  },
  {
    method: "PATCH",
    pattern: re(`/ai/accounts/${n}`),
    action: "ai_account.update",
    objectType: "ai_account",
    extract: ({ body }) => ({ detail: { keyChanged: field(body, "apiKey") !== undefined } }),
  },
  { method: "DELETE", pattern: re(`/ai/accounts/${n}`), action: "ai_account.delete", objectType: "ai_account" },
  { method: "PATCH", pattern: re(`/ai/models/${n}`), action: "ai_model.update", objectType: "ai_model" },
  { method: "PUT", pattern: re("/budget"), action: "budget.update", objectType: null },
  // App: configurazione, segreti di servizio e d'identità
  {
    method: "POST",
    pattern: re("/apps"),
    action: "app.create",
    objectType: "app",
    extract: ({ payload }) => ({ objectId: idOf(field(payload, "id")) }),
  },
  {
    method: "PATCH",
    pattern: re(`/apps/${n}`),
    action: "app.update",
    objectType: "app",
    extract: ({ body }) => ({
      detail: {
        serviceSecretChanged: field(body, "serviceSecret") !== undefined,
        sourceTokenChanged: field(body, "sourceToken") !== undefined,
      },
    }),
  },
  { method: "DELETE", pattern: re(`/apps/${n}`), action: "app.delete", objectType: "app" },
  { method: "POST", pattern: re(`/apps/${n}/identity-secret`), action: "app.identity_secret.create", objectType: "app" },
  { method: "DELETE", pattern: re(`/apps/${n}/identity-secret`), action: "app.identity_secret.delete", objectType: "app" },
  { method: "PATCH", pattern: re(`/apps/${n}/bug-settings`), action: "app.bug_settings.update", objectType: "app" },
  {
    method: "POST",
    pattern: re(`/apps/${n}/bugs/${n}/close`),
    action: "bug_report.close",
    objectType: "bug_report",
    extract: ({ params, body }) => ({
      objectId: `${params[0]}:${params[1]}`,
      detail: { status: oneOf(field(body, "status"), ["fixed", "not_a_bug"] as const) },
    }),
  },
  { method: "POST", pattern: re("/app-bootstraps"), action: "app_bootstrap.create", objectType: "app_bootstrap", extract: ({ payload }) => ({ objectId: idOf(field(payload, "id")) }) },
  { method: "DELETE", pattern: re(`/agents/${n}`), action: "agent.delete", objectType: "agent" },
  { method: "DELETE", pattern: re(`/apps/${n}/tools/${n}`), action: "app_tool.delete", objectType: "app_tool", extract: ({ params }) => ({ objectId: params[1] ?? null }) },
  // Inneschi: segreti dei webhook
  { method: "POST", pattern: re(`/triggers/${n}/secret`), action: "trigger.secret.regenerate", objectType: "trigger" },
  {
    method: "PUT",
    pattern: re(`/triggers/${n}/signing-secret`),
    action: "trigger.signing_secret.update",
    objectType: "trigger",
    extract: ({ body }) => ({ detail: { set: typeof field(body, "secret") === "string" } }),
  },
  { method: "DELETE", pattern: re(`/triggers/${n}`), action: "trigger.delete", objectType: "trigger" },
  // Nodi e abbinamenti (mai il codice di abbinamento)
  {
    method: "POST",
    pattern: re("/account/nodes"),
    action: "node.create",
    objectType: "node",
    extract: ({ payload }) => ({ objectId: idOf(field(field(payload, "node"), "id")) }),
  },
  { method: "POST", pattern: re(`/account/nodes/${n}/token`), action: "node.token.regenerate", objectType: "node" },
  { method: "POST", pattern: re(`/account/nodes/${n}/disable`), action: "node.disable", objectType: "node" },
  { method: "POST", pattern: re(`/account/nodes/${n}/uninstall-request`), action: "node.uninstall_request", objectType: "node" },
  { method: "DELETE", pattern: re(`/account/nodes/${n}`), action: "node.delete", objectType: "node" },
  {
    method: "POST",
    pattern: re("/account/node-pairings/[^/]+/approve"),
    action: "node_pairing.approve",
    objectType: "node",
    extract: ({ body }) => {
      const replace = idOf(field(body, "replaceNodeId"));
      return { objectId: replace, detail: { replace: replace !== null } };
    },
  },
  { method: "POST", pattern: re("/account/node-pairings/[^/]+/deny"), action: "node_pairing.deny", objectType: null },
  // Collegamenti OAuth (app Claude, pannello incorporato)
  { method: "DELETE", pattern: re(`/account/oauth-grants/${n}`), action: "oauth_grant.revoke", objectType: "oauth_grant" },
  // Istruzioni personali dei personaggi
  { method: "PUT", pattern: re("/account/character-instructions/(alfred|lucius)"), action: "character_instructions.update", objectType: "character" },
  { method: "POST", pattern: re("/account/character-instructions/(alfred|lucius)/restore"), action: "character_instructions.restore", objectType: "character" },
  // Ciclo di evoluzione automatica (consenso e spesa)
  { method: "PUT", pattern: re(`/apps/${n}/evolution`), action: "evolution.save", objectType: "app" },
  { method: "DELETE", pattern: re(`/apps/${n}/evolution`), action: "evolution.delete", objectType: "app" },
  { method: "POST", pattern: re(`/apps/${n}/evolution/stop`), action: "evolution.stop", objectType: "app" },
  { method: "POST", pattern: re(`/apps/${n}/evolution/resume`), action: "evolution.resume", objectType: "app" },
  { method: "POST", pattern: re(`/apps/${n}/evolution/run-now`), action: "evolution.run_now", objectType: "app" },
  // Squadre: attivazione (chi paga), chiusura, PLAN corretto dall'utente
  { method: "POST", pattern: re(`/team-instances/${n}/activate`), action: "team.activate", objectType: "team_instance" },
  { method: "POST", pattern: re(`/team-instances/${n}/close`), action: "team.close", objectType: "team_instance" },
  { method: "PUT", pattern: re(`/team-instances/${n}/plan`), action: "team_plan.update", objectType: "team_instance" },
  { method: "PUT", pattern: re(`/team-instances/${n}/budget`), action: "team.budget.update", objectType: "team_instance" },
];

export interface AuditMatch {
  route: AuditRoute;
  params: string[];
}

/** Route del registro per metodo e percorso (relativo a /api), o null. */
export function matchAuditRoute(method: string, path: string): AuditMatch | null {
  const m = method.toUpperCase();
  for (const route of AUDIT_ROUTES) {
    if (route.method !== m) continue;
    const found = route.pattern.exec(path);
    if (found) return { route, params: found.slice(1).map((p) => p ?? "") };
  }
  return null;
}

/** Evento della route: azione, oggetto e dettaglio. Un estrattore che fallisce lascia i valori predefiniti. */
export function auditEventFor(match: AuditMatch, body: unknown, payload: unknown) {
  let extra: AuditExtract = {};
  try {
    extra = match.route.extract?.({ params: match.params, body, payload }) ?? {};
  } catch {
    extra = {};
  }
  const objectId = extra.objectId !== undefined ? extra.objectId : (match.params[0] ?? null);
  return {
    action: extra.action ?? match.route.action,
    objectType: match.route.objectType,
    objectId: objectId === null || objectId === "" ? null : String(objectId),
    detail: extra.detail ?? null,
  };
}
