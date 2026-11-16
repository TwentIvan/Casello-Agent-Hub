export type PostScript = { path: string; sql: string };

/** Contenuto di una voce `merge` (args = { prNumber, prUrl, repo, planTaskId, baseBranch, files, moreFiles, postScripts }). */
export function readMergeArgs(args: unknown) {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const url = typeof a.prUrl === "string" && /^https:\/\//.test(a.prUrl) ? a.prUrl : null;
  return {
    prNumber: typeof a.prNumber === "number" ? a.prNumber : null,
    prUrl: url,
    repo: typeof a.repo === "string" ? a.repo : "",
    planTaskId: typeof a.planTaskId === "string" ? a.planTaskId : "",
    baseBranch: typeof a.baseBranch === "string" ? a.baseBranch : "",
    files: Array.isArray(a.files) ? a.files.filter((f): f is string => typeof f === "string") : [],
    moreFiles: typeof a.moreFiles === "number" ? a.moreFiles : 0,
    postScripts: Array.isArray(a.postScripts)
      ? a.postScripts.flatMap((x): PostScript[] => {
          const o = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
          return o && typeof o.path === "string" && typeof o.sql === "string" ? [{ path: o.path, sql: o.sql }] : [];
        })
      : [],
  };
}
