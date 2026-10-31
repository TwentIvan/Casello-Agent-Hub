import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CircleDot, FileDown } from "lucide-react";
import { getGetAppPlanQueryKey, useGetAppPlan, type AnalysisChapter } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ExportDialog } from "@/components/analysis/export-dialog";
import { ItemCard } from "@/components/analysis/item-card";
import {
  CHAPTER_LABELS,
  completionInfo,
  dependencyOrder,
} from "@/components/analysis/payload";
import { CreateIssuesDialog } from "@/components/plan/create-issues-dialog";
import { IssuesSummary } from "@/components/plan/issues-summary";
import { MAX_ISSUES_PER_REQUEST, useIssueSelection } from "@/components/plan/use-issue-selection";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";

const PLAN_CHAPTERS: AnalysisChapter[] = ["endpoint", "completion", "evolution"];
const EMPTY: never[] = [];

/** Il piano dell'app: endpoint mancanti, completamento ed evoluzione, con le voci nate in chat. */
export function PlanList({ appId }: { appId: number }) {
  const plan = useGetAppPlan(appId, { query: { queryKey: getGetAppPlanQueryKey(appId) } });
  const [exportOpen, setExportOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const selection = useIssueSelection(plan.data?.items ?? EMPTY);

  const sections = useMemo(() => {
    const items = plan.data?.items ?? [];
    const titles = new Map(items.filter((i) => i.chapter === "completion").map((i) => [completionInfo(i).key, completionInfo(i).title]));
    return {
      titles,
      groups: PLAN_CHAPTERS.map((chapter) => {
        const own = items.filter((i) => i.chapter === chapter);
        return { chapter, items: chapter === "completion" ? dependencyOrder(own) : own };
      }).filter((g) => g.items.length > 0),
    };
  }, [plan.data]);

  if (plan.isError) {
    return <p className="text-sm text-destructive">Impossibile caricare il piano: {apiErrorMessage(plan.error)}</p>;
  }
  if (!plan.data) return <Skeleton className="h-40 w-full" />;
  if (plan.data.analysisId === null) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        Nessuna analisi completata: avvia l'analisi dell'app per avere un piano.
      </p>
    );
  }
  if (sections.groups.length === 0) {
    return <p className="text-sm text-muted-foreground">Il piano è vuoto.</p>;
  }

  const issues = plan.data.issues;
  const selectedCount = selection.selectedIds.length;

  return (
    <div className="space-y-6">
      <IssuesSummary appId={appId} summary={issues} />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {selection.eligibleCount > 0 && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={selection.selectAll}>
              Seleziona tutte le approvate senza issue
            </Button>
          )}
          <Button
            size="sm"
            disabled={!issues.available || selectedCount === 0 || selectedCount > MAX_ISSUES_PER_REQUEST}
            onClick={() => setIssuesOpen(true)}
          >
            <CircleDot />
            Crea issue ({selectedCount})
          </Button>
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
            <FileDown />
            Esporta tutta l'analisi
          </Button>
        </div>
        {!issues.available && issues.unavailableReason && (
          <p className="text-right text-xs text-muted-foreground">
            {issues.unavailableReason}{" "}
            <Link href={`/apps/${appId}`} className="underline underline-offset-2">
              Apri la scheda dell'app
            </Link>
          </p>
        )}
        {selectedCount > MAX_ISSUES_PER_REQUEST && (
          <p className="text-right text-xs text-destructive">
            Al massimo {MAX_ISSUES_PER_REQUEST} voci per volta: deselezionane qualcuna.
          </p>
        )}
      </div>
      <ExportDialog analysisId={plan.data.analysisId} open={exportOpen} onOpenChange={setExportOpen} />
      <CreateIssuesDialog
        appId={appId}
        itemIds={selection.selectedIds}
        repo={issues.repo}
        open={issuesOpen}
        onOpenChange={setIssuesOpen}
      />
      {sections.groups.map(({ chapter, items }) => (
        <section key={chapter} className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {CHAPTER_LABELS[chapter]} ({items.length})
          </h3>
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-3">
              {selection.eligibleCount > 0 && (
                <div className="w-4 shrink-0 pt-6">
                  {selection.isEligible(item.id) && (
                    <Checkbox
                      aria-label="Seleziona per creare la issue"
                      checked={selection.isSelected(item.id)}
                      onCheckedChange={(checked) => selection.toggle(item.id, checked === true)}
                    />
                  )}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <ItemCard
                  item={item}
                  appId={appId}
                  dependsOnTitles={
                    chapter === "completion"
                      ? completionInfo(item).dependsOn.map((key) => sections.titles.get(key) ?? key)
                      : undefined
                  }
                />
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
