import { useState } from "react";
import { Copy } from "lucide-react";
import { getExportAnalysisIssuesQueryKey, useExportAnalysisIssues } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CHAPTER_LABELS, type ExportableChapter } from "@/components/analysis/payload";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

interface ExportDialogProps {
  analysisId: number;
  /** Senza capitolo si esporta tutta l'analisi. */
  chapter?: ExportableChapter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Testo Markdown di un capitolo o di tutta l'analisi, pronto da copiare.
 * L'API esporta uno stato alla volta: "anche in attesa" aggiunge una seconda richiesta e il suo
 * testo segue quello degli approvati.
 */
export function ExportDialog({ analysisId, chapter, open, onOpenChange }: ExportDialogProps) {
  const { toast } = useToast();
  const [includePending, setIncludePending] = useState(false);

  const approvedParams = { ...(chapter ? { chapter } : {}), status: "approved" } as const;
  const pendingParams = { ...(chapter ? { chapter } : {}), status: "pending" } as const;
  const approved = useExportAnalysisIssues(analysisId, approvedParams, {
    query: { queryKey: getExportAnalysisIssuesQueryKey(analysisId, approvedParams), enabled: open },
  });
  const pending = useExportAnalysisIssues(analysisId, pendingParams, {
    query: { queryKey: getExportAnalysisIssuesQueryKey(analysisId, pendingParams), enabled: open && includePending },
  });

  const loading = approved.isLoading || (includePending && pending.isLoading);
  const error = approved.error ?? (includePending ? pending.error : null);

  const approvedMd = approved.data?.markdown ?? "";
  const pendingMd = includePending ? (pending.data?.markdown ?? "") : "";
  const count = (approved.data?.count ?? 0) + (includePending ? (pending.data?.count ?? 0) : 0);
  const markdown =
    approvedMd && pendingMd
      ? chapter
        ? `# Approvati\n\n${approvedMd}\n\n# In attesa di approvazione\n\n${pendingMd}`
        : // Nell'esportazione completa i capitoli usano già il titolo `#`: lo stato va in un separatore
          `${approvedMd}\n\n---\n\n(Elementi in attesa di approvazione)\n\n${pendingMd}`
      : approvedMd || pendingMd;
  const kind = chapter === "tool" || chapter === "agent" || chapter === "skill" ? "elementi" : "issue";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast({ title: "Testo copiato", description: `${count} ${kind === "issue" && !chapter ? "elementi" : kind} negli appunti.` });
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona il testo e copialo a mano." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{chapter ? `Esporta: ${CHAPTER_LABELS[chapter]}` : "Esporta tutta l'analisi"}</DialogTitle>
          <DialogDescription>
            {chapter === "tool" || chapter === "agent" || chapter === "skill"
              ? "Documentazione in Markdown con descrizione, punti chiave e prove."
              : chapter
                ? 'Testo in Markdown con titolo, contesto, cosa fare, criterio "pronto quando" e prove, da incollare nel repo dell\'app.'
                : "Un unico Markdown con tutti i capitoli, nell'ordine delle fasi: documentazione per tool, agenti e skill, issue per il resto."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id="export-include-pending"
            checked={includePending}
            onCheckedChange={(checked) => setIncludePending(checked === true)}
          />
          <Label htmlFor="export-include-pending" className="font-normal">
            Includi anche gli elementi in attesa
          </Label>
        </div>
        {error ? (
          <p className="text-sm text-destructive">Esportazione non riuscita: {apiErrorMessage(error)}</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Preparazione del testo…</p>
        ) : !markdown ? (
          <p className="text-sm text-muted-foreground">
            {includePending
              ? `Nessun elemento approvato o in attesa ${chapter ? "in questo capitolo" : "nell'analisi"}.`
              : `Nessun elemento approvato ${chapter ? "in questo capitolo" : "nell'analisi"}: approvane qualcuno o includi quelli in attesa.`}
          </p>
        ) : (
          <pre className="max-h-[55vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            {markdown}
          </pre>
        )}
        <DialogFooter className="gap-2">
          {markdown && <span className="mr-auto self-center text-xs text-muted-foreground">{count} elementi</span>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Chiudi
          </Button>
          <Button onClick={() => void copy()} disabled={!markdown || loading}>
            <Copy />
            Copia
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
