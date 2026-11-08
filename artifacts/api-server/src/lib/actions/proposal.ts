// Logica pura della proposta multipla (strumento `proponi`): forma degli argomenti, riferimenti
// `{{pN.campo}}` tra passi ed esclusioni a catena. Nessun DB, nessuna rete.

export const PROPOSAL_TITLE_MAX = 200;
export const PROPOSAL_REASON_MAX = 1_000;
export const PROPOSAL_STEPS_MAX = 20;
export const STEP_SUMMARY_MAX = 300;

export const PROPOSAL_MESSAGES = {
  badRef: (key: string) => `riferimento non valido nel passo ${key}`,
  alreadyProposed: "hai già proposto in questa run: usa la discussione",
  badExclude: "passi da escludere non validi",
  nothingToRun: "nessun passo da eseguire: rifiuta la proposta",
  unresolved: "riferimento non risolto",
  toolUnusable: "strumento non più utilizzabile",
  stoppedAt: (done: number, total: number, key: string) =>
    `eseguiti ${done} passi su ${total}: si è fermata al passo ${key}`,
  badIds: "id dei passi non validi: p1, p2… nell'ordine",
  badTitle: `titolo obbligatorio, al massimo ${PROPOSAL_TITLE_MAX} caratteri`,
  badReason: `motivo al massimo ${PROPOSAL_REASON_MAX} caratteri`,
  badSteps: `servono da 1 a ${PROPOSAL_STEPS_MAX} passi`,
  badStep: (key: string) => `passo ${key} non valido: servono strumento, argomenti (oggetto) e sintesi`,
} as const;

export interface ProposalStepInput {
  key: string;
  toolName: string;
  args: Record<string, unknown>;
  summary: string;
}
export interface ProposalInput {
  title: string;
  reason: string | null;
  steps: ProposalStepInput[];
}
export interface StepRef {
  param: string;
  step: string;
  field: string[];
}

const REF_RE = /^\{\{(p(?:[1-9]|1\d|20))\.([A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,4})\}\}$/;
const REF_HINT_RE = /\{\{p\d/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseProposalArgs(
  args: Record<string, unknown>,
): { ok: true; value: ProposalInput } | { ok: false; message: string } {
  const M = PROPOSAL_MESSAGES;
  const title = typeof args.titolo === "string" ? args.titolo.trim() : "";
  if (title.length < 1 || title.length > PROPOSAL_TITLE_MAX) return { ok: false, message: M.badTitle };

  let reason: string | null = null;
  if (args.motivo !== undefined && args.motivo !== null) {
    if (typeof args.motivo !== "string" || args.motivo.length > PROPOSAL_REASON_MAX) {
      return { ok: false, message: M.badReason };
    }
    reason = args.motivo.trim() || null;
  }

  const raw = args.passi;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PROPOSAL_STEPS_MAX) {
    return { ok: false, message: M.badSteps };
  }
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!isPlainObject(s) || s.id !== `p${i + 1}`) return { ok: false, message: M.badIds };
  }

  const steps: ProposalStepInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown>;
    const key = `p${i + 1}`;
    const summary = typeof s.sintesi === "string" ? s.sintesi.trim() : "";
    if (
      typeof s.strumento !== "string" ||
      s.strumento.trim() === "" ||
      !isPlainObject(s.argomenti) ||
      summary.length < 1 ||
      summary.length > STEP_SUMMARY_MAX
    ) {
      return { ok: false, message: M.badStep(key) };
    }
    const refs = stepRefs(s.argomenti);
    if (!Array.isArray(refs)) return { ok: false, message: M.badRef(key) };
    const before = new Set(steps.map((p) => p.key));
    if (refs.some((r) => !before.has(r.step))) return { ok: false, message: M.badRef(key) };
    steps.push({ key, toolName: s.strumento, args: s.argomenti, summary });
  }
  return { ok: true, value: { title, reason, steps } };
}

export function stepRefs(args: unknown): StepRef[] | { badRef: true } {
  const out: StepRef[] = [];
  let bad = false;
  const walk = (v: unknown, path: string[]): void => {
    if (bad) return;
    if (typeof v === "string") {
      const m = REF_RE.exec(v);
      if (m) out.push({ param: path.join("."), step: m[1]!, field: m[2]!.split(".") });
      else if (REF_HINT_RE.test(v)) bad = true;
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, [...path, String(i)]));
    } else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    }
  };
  walk(args, []);
  return bad ? { badRef: true } : out;
}

export function resolveRefs(
  args: Record<string, unknown>,
  results: Map<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false } {
  let failed = false;
  const walk = (v: unknown): unknown => {
    if (failed) return v;
    if (typeof v === "string") {
      const m = REF_RE.exec(v);
      if (!m) return v;
      let cur: unknown = results.get(m[1]!);
      for (const seg of m[2]!.split(".")) {
        if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, seg)) {
          failed = true;
          return v;
        }
        cur = (cur as Record<string, unknown>)[seg];
      }
      if (cur === undefined) failed = true;
      return cur;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const resolved = walk(args) as Record<string, unknown>;
  return failed ? { ok: false } : { ok: true, args: resolved };
}

export function planExclusion(
  steps: { key: string; refs: StepRef[] }[],
  exclude: string[],
): { ok: true; excluded: Set<string>; skipped: Set<string> } | { ok: false; message: string } {
  const keys = new Set(steps.map((s) => s.key));
  const excluded = new Set<string>();
  for (const k of exclude) {
    if (!keys.has(k) || excluded.has(k)) return { ok: false, message: PROPOSAL_MESSAGES.badExclude };
    excluded.add(k);
  }
  const skipped = new Set<string>();
  for (const s of steps) {
    if (excluded.has(s.key)) continue;
    if (s.refs.some((r) => excluded.has(r.step) || skipped.has(r.step))) skipped.add(s.key);
  }
  if (steps.every((s) => excluded.has(s.key) || skipped.has(s.key))) {
    return { ok: false, message: PROPOSAL_MESSAGES.nothingToRun };
  }
  return { ok: true, excluded, skipped };
}
