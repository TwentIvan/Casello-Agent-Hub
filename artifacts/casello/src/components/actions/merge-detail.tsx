/** Contenuto di una voce `merge` (args = { prNumber, prUrl, repo, planTaskId, baseBranch, files, moreFiles }). */
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
  };
}

/** Merge di una PR di una squadra che tocca migrazioni o schema: link alla PR e file da applicare prima su Neon. */
export function MergeDetail({ args }: { args: unknown }) {
  const m = readMergeArgs(args);
  return (
    <div className="space-y-2 text-sm">
      <p>
        {m.prUrl ? (
          <a href={m.prUrl} target="_blank" rel="noopener" className="font-mono hover:underline">
            PR #{m.prNumber ?? "?"}
          </a>
        ) : (
          <span className="font-mono">PR #{m.prNumber ?? "?"}</span>
        )}{" "}
        · {m.repo}
        {m.baseBranch && <> → <span className="font-mono">{m.baseBranch}</span></>}
        {m.planTaskId && <> · compito <span className="font-mono">{m.planTaskId}</span></>}
      </p>
      <p className="text-muted-foreground">
        La PR tocca migrazioni o schema del DB: applica l'SQL su Neon, poi approva. Botcave unisce con squash solo con la CI verde e la
        stessa testa della richiesta.
      </p>
      {m.files.length > 0 && (
        <ul className="space-y-0.5 font-mono text-xs">
          {m.files.map((f) => (
            <li key={f} className="break-all">
              {f}
            </li>
          ))}
          {m.moreFiles > 0 && <li className="text-muted-foreground">e altri {m.moreFiles} file</li>}
        </ul>
      )}
    </div>
  );
}
