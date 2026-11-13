import type { ChatTarget, PageContext } from "../characters/adapters";
import { SUBJECT_LABELS } from "../characters/targets";

/** Pagina della console per il contesto di Alfred, dall'indirizzo (pagine della mappa; le altre: `console`). */
export function pageFromPath(path: string): PageContext {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return { page: "dashboard" };
  const m = /^\/(teams|runs)\/([^/]+)$/.exec(clean);
  if (m) return { page: m[1] === "teams" ? "team" : "run", id: decodeURIComponent(m[2]).slice(0, 100) };
  if (clean === "/teams") return { page: "teams" };
  if (clean === "/runs") return { page: "runs" };
  if (clean === "/pending-actions") return { page: "pending_actions" };
  return { page: "console" };
}

/** Pagina della console per il contesto del Responsabile di Botcave: tutte le aree, le altre pagine `console`. */
export type LeadPageContext = { page: string; id?: string };

const LEAD_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const LEAD_LISTS: Record<string, string> = {
  "/": "dashboard",
  "/apps": "apps",
  "/agents": "agents",
  "/runs": "runs",
  "/pending-actions": "pending_actions",
  "/skills": "skills",
  "/team-templates": "team_templates",
  "/teams": "teams",
  "/models": "models",
  "/account": "account",
};
const LEAD_DETAILS: [RegExp, string][] = [
  [/^\/apps\/([^/]+)\/plan$/, "app_plan"],
  [/^\/apps\/([^/]+)$/, "app"],
  [/^\/analyses\/([^/]+)$/, "analysis"],
  [/^\/agents\/([^/]+)$/, "agent"],
  [/^\/runs\/([^/]+)$/, "run"],
  [/^\/skills\/([^/]+)$/, "skill"],
  [/^\/team-templates\/([^/]+)$/, "team_template"],
  [/^\/teams\/([^/]+)$/, "team"],
];

function leadId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw);
    return LEAD_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function leadPageFromPath(path: string): LeadPageContext {
  const clean = path.replace(/\/+$/, "") || "/";
  const list = LEAD_LISTS[clean];
  if (list) return { page: list };
  for (const [re, page] of LEAD_DETAILS) {
    const m = re.exec(clean);
    if (m) {
      const id = leadId(m[1]!);
      return id === null ? { page } : { page, id };
    }
  }
  return { page: "console" };
}

export const LUCIUS_SUBJECTS = new Set(Object.keys(SUBJECT_LABELS));

export function positiveInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Bersaglio di una scheda `handoff` (`{to, subjectType, subjectId, question}`); null se il payload non è valido. */
export function handoffTarget(payload: Record<string, unknown> | null, currentPage: PageContext): { target: ChatTarget; draft: string } | null {
  if (!payload) return null;
  const question = typeof payload.question === "string" ? payload.question : "";
  const subjectType = typeof payload.subjectType === "string" ? payload.subjectType : "";
  const subjectId = typeof payload.subjectId === "string" ? payload.subjectId : null;
  if (payload.to === "alfred") return { target: { kind: "alfred", page: currentPage }, draft: question };
  if (payload.to !== "lucius") return null;
  if (subjectType === "plan") {
    const appId = positiveInt(subjectId);
    return appId === null ? null : { target: { kind: "plan", appId }, draft: question };
  }
  if (subjectType === "team") {
    const instanceId = positiveInt(subjectId);
    // Lo stato della squadra lo rilegge l'adattatore: chiusa → sola lettura
    return instanceId === null ? null : { target: { kind: "team", instanceId, closed: false }, draft: question };
  }
  if (LUCIUS_SUBJECTS.has(subjectType)) {
    return {
      target: { kind: "character", subjectType: subjectType as keyof typeof SUBJECT_LABELS, subjectId, title: "" },
      draft: question,
    };
  }
  return null;
}

/** Etichetta di un argomento di Lucius per «Torna a…». */
export function targetLabel(target: ChatTarget): string {
  switch (target.kind) {
    case "alfred":
      return "Alfred";
    case "lead":
      return "Responsabile";
    case "plan":
      return "piano dell'app";
    case "team":
      return "chat della squadra";
    case "character": {
      const label = SUBJECT_LABELS[target.subjectType];
      const title = target.title.trim();
      if (!title) return label;
      // Il titolo dato dalle pagine ha già il prefisso (es. «Agente · Nome»)
      return title.startsWith(label) ? title : `${label} · ${title}`;
    }
  }
}
