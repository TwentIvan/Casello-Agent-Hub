import { useMemo, useState } from "react";
import { FileDown } from "lucide-react";
import type { AnalysisChapter, AnalysisItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExportDialog } from "@/components/analysis/export-dialog";
import { ItemCard } from "@/components/analysis/item-card";
import {
  CHAPTERS,
  CHAPTER_LABELS,
  POSTPONABLE,
  completionInfo,
  dependencyOrder,
  num,
  str,
} from "@/components/analysis/payload";

interface ChapterTabsProps {
  analysisId: number;
  appId: number;
  items: AnalysisItem[];
}

function Counters({ items }: { items: AnalysisItem[] }) {
  const pending = items.filter((i) => i.status === "pending").length;
  const approved = items.filter((i) => i.status === "approved").length;
  return (
    <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums" title={`${pending} in attesa, ${approved} approvati`}>
      {pending}/{approved}
    </span>
  );
}

function GroupHeading({ children }: { children: string }) {
  return <h4 className="pt-2 text-sm font-semibold tracking-tight text-muted-foreground">{children}</h4>;
}

/** Piano di completamento: per fase, e dentro la fase nell'ordine delle dipendenze. */
function CompletionList({ items, appId }: { items: AnalysisItem[]; appId: number }) {
  const { groups, titles } = useMemo(() => {
    const titles = new Map(items.map((i) => [completionInfo(i).key, completionInfo(i).title]));
    const phases = [...new Set(items.map((i) => completionInfo(i).phase))].sort(
      (a, b) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER),
    );
    const groups = phases.map((phase) => ({
      phase,
      items: dependencyOrder(items.filter((i) => completionInfo(i).phase === phase)),
    }));
    return { groups, titles };
  }, [items]);

  return (
    <div className="space-y-3">
      {groups.map(({ phase, items: inPhase }) => (
        <section key={phase ?? "none"} className="space-y-3">
          <GroupHeading>{phase === undefined ? "Senza fase" : `Fase ${phase}`}</GroupHeading>
          {inPhase.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              appId={appId}
              dependsOnTitles={completionInfo(item).dependsOn.map((key) => titles.get(key) ?? key)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** Evoluzione: per area, e dentro l'area per priorità (1 = massima). */
function EvolutionList({ items, appId }: { items: AnalysisItem[]; appId: number }) {
  const groups = useMemo(() => {
    const byArea = new Map<string, AnalysisItem[]>();
    for (const item of items) {
      const area = str(item.payload, "area")?.trim() || "Senza area";
      byArea.set(area, [...(byArea.get(area) ?? []), item]);
    }
    const priority = (i: AnalysisItem) => num(i.payload, "priority") ?? Number.MAX_SAFE_INTEGER;
    return [...byArea.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "it"))
      .map(([area, list]) => ({
        area,
        // sort è stabile: a pari priorità resta l'ordine di posizione
        items: [...list].sort((a, b) => priority(a) - priority(b)),
      }));
  }, [items]);

  return (
    <div className="space-y-3">
      {groups.map(({ area, items: inArea }) => (
        <section key={area} className="space-y-3">
          <GroupHeading>{area}</GroupHeading>
          {inArea.map((item) => (
            <ItemCard key={item.id} item={item} appId={appId} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ChapterList({ chapter, items, appId }: { chapter: AnalysisChapter; items: AnalysisItem[]; appId: number }) {
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Nessun elemento in questo capitolo.</p>;
  }
  if (chapter === "completion") return <CompletionList items={items} appId={appId} />;
  if (chapter === "evolution") return <EvolutionList items={items} appId={appId} />;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ItemCard key={item.id} item={item} appId={appId} />
      ))}
    </div>
  );
}

/** Schede per capitolo con i contatori (in attesa / approvati) e l'esportazione delle issue. */
export function ChapterTabs({ analysisId, appId, items }: ChapterTabsProps) {
  const byChapter = useMemo(() => {
    const map = new Map<AnalysisChapter, AnalysisItem[]>(CHAPTERS.map((c) => [c, []]));
    for (const item of items) map.get(item.chapter)?.push(item);
    return map;
  }, [items]);

  const [tab, setTab] = useState<AnalysisChapter>(
    () => CHAPTERS.find((c) => (byChapter.get(c)?.length ?? 0) > 0) ?? "tool",
  );
  // undefined = nessuna finestra; null = tutta l'analisi; altrimenti il capitolo
  const [exporting, setExporting] = useState<AnalysisChapter | null | undefined>(undefined);
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as AnalysisChapter)} className="space-y-4">
      <TabsList className="h-auto flex-wrap justify-start">
        {CHAPTERS.map((chapter) => (
          <TabsTrigger key={chapter} value={chapter}>
            {CHAPTER_LABELS[chapter]}
            <Counters items={byChapter.get(chapter) ?? []} />
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setExporting(null);
            setExportOpen(true);
          }}
        >
          <FileDown />
          Esporta tutta l'analisi
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Accanto a ogni capitolo: elementi in attesa / approvati.</p>
      {CHAPTERS.map((chapter) => (
        <TabsContent key={chapter} value={chapter} className="space-y-3">
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setExporting(chapter);
                setExportOpen(true);
              }}
            >
              <FileDown />
              {POSTPONABLE.has(chapter) ? "Esporta issue" : "Esporta"}
            </Button>
          </div>
          <ChapterList chapter={chapter} items={byChapter.get(chapter) ?? []} appId={appId} />
        </TabsContent>
      ))}
      {exporting !== undefined && (
        <ExportDialog
          key={exporting ?? "all"}
          analysisId={analysisId}
          chapter={exporting ?? undefined}
          open={exportOpen}
          onOpenChange={setExportOpen}
        />
      )}
    </Tabs>
  );
}
