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
