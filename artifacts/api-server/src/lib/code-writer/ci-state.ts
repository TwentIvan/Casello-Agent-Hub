import type { CiSnapshot } from "./github-git";

export type CiState = "pending" | "success" | "failure" | "none";

/** Attesa massima di una CI che non compare (spec §6.2). */
export const CI_NONE_AFTER_MS = 600_000;

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);
const FAILED_STATES = new Set(["failure", "error"]);

export function ciState(s: CiSnapshot, sinceCommitMs: number): CiState {
  if (s.checks.length === 0 && s.statuses.length === 0) {
    return sinceCommitMs >= CI_NONE_AFTER_MS ? "none" : "pending";
  }
  if (s.checks.some((c) => c.status !== "completed") || s.statuses.some((x) => x.state === "pending")) {
    return "pending";
  }
  if (
    s.checks.some((c) => c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion)) ||
    s.statuses.some((x) => FAILED_STATES.has(x.state))
  ) {
    return "failure";
  }
  return "success";
}

export function failedNames(s: CiSnapshot): string[] {
  const names = [
    ...s.checks.filter((c) => c.conclusion !== null && FAILED_CONCLUSIONS.has(c.conclusion)).map((c) => c.name),
    ...s.statuses.filter((x) => FAILED_STATES.has(x.state)).map((x) => x.context),
  ];
  return [...new Set(names)];
}

export function ciSummary(s: CiSnapshot): string {
  const failed = failedNames(s);
  if (failed.length === 0) return "CI verde";
  const text = `CI non superata: ${failed.join(", ")}`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
