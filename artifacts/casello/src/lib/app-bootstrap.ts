// Nuova app da zero: regole del modulo, le stesse del server (`lib/app-bootstrap/naming.ts`).
import type { BootstrapChecklistItem } from "@workspace/api-client-react";
import type { LedState } from "@/components/brand/led";

export const DEFAULT_BASE_DOMAIN = "fantamister.cloud";

/** Slug proposto dal nome: minuscole, senza accenti, trattini al posto dei separatori, al più 64 caratteri. */
export function slugFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function suggestedDomain(slug: string, baseDomain: string = DEFAULT_BASE_DOMAIN): string {
  return `${slug}.${baseDomain}`;
}

/** Vero se il dominio è ancora quello proposto per lo slug precedente (o è vuoto): allora segue lo slug. */
export function domainFollowsSlug(domain: string, previousSlug: string, baseDomain: string = DEFAULT_BASE_DOMAIN): boolean {
  return domain.trim() === "" || domain.trim().toLowerCase() === suggestedDomain(previousSlug, baseDomain);
}

/** Il repository si chiama come lo slug: `proprietario/slug`, senza distinguere le maiuscole. */
export function repoMatchesSlug(repo: string, slug: string): boolean {
  const parts = repo.trim().split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1]!.toLowerCase() === slug;
}

export function templateGenerateUrl(templateRepo: string): string {
  return `https://github.com/${templateRepo}/generate`;
}

/** LED di una voce della checklist: fatta, in verifica (`health` controllato e non ancora ok) o da fare. */
export function checklistLed(
  item: BootstrapChecklistItem,
  health?: { healthCheckedAt: string | null; healthOkAt: string | null },
): LedState {
  if (item.done) return "ok";
  if (item.key === "health" && health?.healthCheckedAt && !health.healthOkAt) return "work";
  return "idle";
}

export type BootstrapArgs = {
  bootstrapId: number | null;
  name: string;
  slug: string;
  domain: string;
  repo: string;
  steps: string[];
  analysisEstimateUsd: number | null;
  monthly: string;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Contenuto di una voce `app_bootstrap` (`argsPublic`). */
export function readBootstrapArgs(args: unknown): BootstrapArgs {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  return {
    bootstrapId: typeof a.bootstrapId === "number" ? a.bootstrapId : null,
    name: str(a.name),
    slug: str(a.slug),
    domain: str(a.domain),
    repo: str(a.repo),
    steps: Array.isArray(a.steps) ? a.steps.filter((s): s is string => typeof s === "string") : [],
    analysisEstimateUsd: typeof a.analysisEstimateUsd === "number" ? a.analysisEstimateUsd : null,
    monthly: str(a.monthly),
  };
}
