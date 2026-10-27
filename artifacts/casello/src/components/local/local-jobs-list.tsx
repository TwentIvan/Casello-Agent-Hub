import { Link } from "wouter";
import type { LocalJob, LocalJobStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/format";
import { useChooseJob, useLocalJobs } from "./local-choice-dialog";

const JOB_STATUS_LABELS: Partial<Record<LocalJobStatus, string>> = {
  waiting_choice: "in attesa di una scelta",
  postponed: "posticipato",
};

function jobTarget(job: LocalJob): { href: string; label: string } | null {
  if (job.kind === "run" && job.runId !== null) return { href: `/runs/${job.runId}`, label: `Run #${job.runId}` };
  if (job.kind === "analysis" && job.analysisId !== null) {
    return { href: `/analyses/${job.analysisId}`, label: `Analisi #${job.analysisId}` };
  }
  return null;
}

/** Lavori dell'agente locale in attesa di una scelta o posticipati, con l'azione "Usa la riserva". Vuoto: non si vede. */
export function LocalJobsList() {
  const jobs = useLocalJobs(true, 5000);
  const choose = useChooseJob();
  const waiting = (jobs.data ?? []).filter((j) => j.status === "waiting_choice" || j.status === "postponed");
  if (waiting.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Lavori in attesa dell'agente locale</CardTitle>
        <CardDescription>
          Il runner non era collegato: scegli se usare il modello di riserva o aspettare che si colleghi.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {waiting.map((job) => {
            const target = jobTarget(job);
            return (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {target ? (
                    <Link href={target.href} className="font-medium underline-offset-2 hover:underline">
                      {target.label}
                    </Link>
                  ) : (
                    <span className="font-medium">Lavoro #{job.id}</span>
                  )}
                  <Badge variant="outline" className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    {JOB_STATUS_LABELS[job.status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{formatRelative(job.createdAt)}</span>
                </div>
                <Button
                  size="sm"
                  disabled={job.fallbackAiModelId === null || choose.isPending}
                  onClick={() => choose.mutate({ id: job.id, data: { choice: "fallback" } })}
                >
                  Usa la riserva
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
