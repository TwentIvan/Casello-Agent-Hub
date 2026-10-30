import { useMemo, useState } from "react";
import { FileDown } from "lucide-react";
import { getGetAppPlanQueryKey, useGetAppPlan, type AnalysisChapter } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ExportDialog } from "@/components/analysis/export-dialog";
import { ItemCard } from "@/components/analysis/item-card";
import {
  CHAPTER_LABELS,
  completionInfo,
  dependencyOrder,
} from "@/components/analysis/payload";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";

const PLAN_CHAPTERS: AnalysisChapter[] = ["endpoint", "completion", "evolution"];

/** Il piano dell'app: endpoint mancanti, completamento ed evoluzione, con le voci nate in chat. */
export function PlanList({ appId }: { appId: number }) {
  const plan = useGetAppPlan(appId, { query: { queryKey: getGetAppPlanQueryKey(appId) } });
  const [exportOpen, setExportOpen] = useState(false);

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

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
          <FileDown />
          Esporta tutta l'analisi
        </Button>
      </div>
      <ExportDialog analysisId={plan.data.analysisId} open={exportOpen} onOpenChange={setExportOpen} />
      {sections.groups.map(({ chapter, items }) => (
        <section key={chapter} className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {CHAPTER_LABELS[chapter]} ({items.length})
          </h3>
          {items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              appId={appId}
              dependsOnTitles={
                chapter === "completion"
                  ? completionInfo(item).dependsOn.map((key) => sections.titles.get(key) ?? key)
                  : undefined
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}
