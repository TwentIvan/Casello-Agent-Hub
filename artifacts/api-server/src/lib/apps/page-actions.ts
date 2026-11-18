// Azioni della pagina di un'App ospite (`apps.page_actions`): richieste configurate in Botcave per un tipo di pagina.

import { createHash } from "node:crypto";
import type { PageAction } from "@workspace/db";
import { looksLikeCredential } from "../memory/credentials";

export const PAGE_ACTION_MESSAGES = {
  page: "tipo di pagina non valido",
  label: "etichetta dell'azione non valida",
  request: "richiesta dell'azione non valida",
  perPage: "al massimo 6 azioni per tipo di pagina",
  total: "al massimo 40 azioni per App",
  duplicate: "etichetta ripetuta nello stesso tipo di pagina",
  credential: "l'azione sembra contenere una credenziale",
} as const;

export const PAGE_ACTIONS_PER_PAGE_MAX = 6;
export const PAGE_ACTIONS_TOTAL_MAX = 40;
const LABEL_MAX = 40;
const REQUEST_MAX = 1000;
export const PAGE_RE = /^[A-Za-z0-9._:-]{1,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Azione con quella pagina e quell'etichetta (confronto esatto), altrimenti null. */
export function findPageAction(actions: readonly PageAction[], page: string, label: string): PageAction | null {
  return actions.find((a) => a.page === page && a.label === label) ?? null;
}

/** Controlla e normalizza (trim) l'elenco delle azioni di un'App; il primo errore dà il messaggio fisso. */
export function validatePageActions(actions: unknown): { ok: true; actions: PageAction[] } | { ok: false; error: string } {
  if (!Array.isArray(actions)) return { ok: false, error: PAGE_ACTION_MESSAGES.page };
  if (actions.length > PAGE_ACTIONS_TOTAL_MAX) return { ok: false, error: PAGE_ACTION_MESSAGES.total };
  const out: PageAction[] = [];
  const perPage = new Map<string, Set<string>>();
  for (const raw of actions) {
    const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const page = typeof a["page"] === "string" ? a["page"].trim() : "";
    if (!PAGE_RE.test(page)) return { ok: false, error: PAGE_ACTION_MESSAGES.page };
    const label = typeof a["label"] === "string" ? a["label"].trim() : "";
    if (label === "" || label.length > LABEL_MAX || CONTROL_RE.test(label)) return { ok: false, error: PAGE_ACTION_MESSAGES.label };
    const request = typeof a["request"] === "string" ? a["request"].trim() : "";
    if (request === "" || request.length > REQUEST_MAX) return { ok: false, error: PAGE_ACTION_MESSAGES.request };
    if (looksLikeCredential(label) || looksLikeCredential(request)) return { ok: false, error: PAGE_ACTION_MESSAGES.credential };
    const labels = perPage.get(page) ?? new Set<string>();
    if (labels.has(label)) return { ok: false, error: PAGE_ACTION_MESSAGES.duplicate };
    if (labels.size >= PAGE_ACTIONS_PER_PAGE_MAX) return { ok: false, error: PAGE_ACTION_MESSAGES.perPage };
    labels.add(label);
    perPage.set(page, labels);
    out.push({ page, label, request });
  }
  return { ok: true, actions: out };
}

/** Impronta (SHA-256) delle azioni di un tipo di pagina, in ordine, in JSON canonico. */
export function pageActionsHash(actions: readonly PageAction[], page: string): string {
  const mine = actions.filter((a) => a.page === page).map((a) => ({ page: a.page, label: a.label, request: a.request }));
  return createHash("sha256").update(JSON.stringify(mine)).digest("hex");
}
