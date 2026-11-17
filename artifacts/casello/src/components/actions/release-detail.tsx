import { Led } from "@/components/brand/led";
import { readReleaseArgs, releaseStatusText } from "@/lib/work-status";

/**
 * Voce «Porta in produzione» di un lavoro su branch unico: versione di prova, compiti con issue e PR unite, script `-post` da
 * applicare su Neon dopo il deploy. Approvando, Botcave apre la PR del lavoro verso il base e la unisce con la CI verde.
 */
export function ReleaseDetail({ args, status }: { args: unknown; status: string }) {
  const r = readReleaseArgs(args);
  const waiting = releaseStatusText(status);
  return (
    <div className="space-y-2 text-sm">
      <p className="break-words">
        <span className="font-mono">{r.branch}</span> → <span className="font-mono">{r.baseBranch}</span> · {r.repo}
        {r.headSha && <span className="font-mono text-ink-muted"> · {r.headSha.slice(0, 7)}</span>}
      </p>
      {r.stagingUrl || r.stagingBranch ? (
        <p>
          Versione di prova:{" "}
          {r.stagingUrl ? (
            <a href={r.stagingUrl} target="_blank" rel="noopener" className="break-all hover:underline">
              {r.stagingUrl}
            </a>
          ) : (
            <>
              branch <span className="font-mono">{r.stagingBranch}</span>
            </>
          )}
        </p>
      ) : (
        <p className="text-ink-muted">{r.stagingNote ?? "Nessuna versione di prova configurata per l'App"}</p>
      )}
      {r.tasks.length > 0 && (
        <ul className="space-y-0.5">
          {r.tasks.map((t) => (
            <li key={t.id} className="break-words">
              <span className="font-mono">{t.id}</span> {t.title}
              {t.prNumber !== null &&
                (t.prUrl ? (
                  <>
                    {" · "}
                    <a href={t.prUrl} target="_blank" rel="noopener" className="font-mono hover:underline">
                      PR #{t.prNumber}
                    </a>
                  </>
                ) : (
                  <span className="font-mono"> · PR #{t.prNumber}</span>
                ))}
              {t.issue !== null && <span className="font-mono"> · issue #{t.issue}</span>}
            </li>
          ))}
        </ul>
      )}
      {r.postScripts.length > 0 && (
        <div className="space-y-1 rounded-md border border-border p-2">
          <p className="text-xs text-ink-muted">Da applicare su Neon dopo il deploy</p>
          <ul className="space-y-0.5 font-mono text-xs">
            {r.postScripts.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-ink-muted">
        Approvando, Botcave unisce nel lavoro le novità di {r.baseBranch || "base"}, apre la PR del lavoro e la unisce con un commit di merge solo con la
        CI verde. Rifiutando con una nota il lavoro torna alla squadra.
      </p>
      {waiting && (
        <Led state="work" label={waiting} />
      )}
    </div>
  );
}
