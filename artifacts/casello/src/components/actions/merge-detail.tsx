import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { readMergeArgs } from "@/lib/merge-args";

/** Merge di una PR di una squadra con script `-post`: link alla PR, file e SQL da applicare su Neon dopo il deploy. */
export function MergeDetail({ args }: { args: unknown }) {
  const m = readMergeArgs(args);
  const { toast } = useToast();
  const copy = (sql: string) => {
    void navigator.clipboard
      .writeText(sql)
      .then(() => toast({ title: "SQL copiato" }))
      .catch(() => toast({ variant: "destructive", title: "Copia non riuscita" }));
  };
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
        La PR contiene uno script -post: approvando la unisci, il deploy applica le migrazioni additive e lo script qui sotto va applicato su
        Neon dopo il deploy. Botcave unisce con squash solo con la CI verde e la stessa testa della richiesta.
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
      {m.postScripts.map((script) => (
        <div key={script.path} className="space-y-1 rounded-md border border-border p-2">
          <p className="text-xs text-muted-foreground">Da applicare su Neon dopo il deploy</p>
          <p className="break-all font-mono text-xs">{script.path}</p>
          <div className="max-h-64 overflow-y-auto rounded-md bg-surface-1 p-2">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{script.sql}</pre>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => copy(script.sql)}>
            Copia SQL
          </Button>
        </div>
      ))}
    </div>
  );
}
