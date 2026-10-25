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
  chapter: ExportableChapter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Testo delle issue di un capitolo (Endpoint, Completamento, Evoluzione), pronto da copiare.
 * L'API esporta uno stato alla volta: "anche in attesa" aggiunge una seconda richiesta e il suo
 * testo segue quello degli approvati.
 */
export function ExportDialog({ analysisId, chapter, open, onOpenChange }: ExportDialogProps) {
  const { toast } = useToast();
  const [includePending, setIncludePending] = useState(false);

  const approvedParams = { chapter, status: "approved" } as const;
  const pendingParams = { chapter, status: "pending" } as const;
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
      ? `# Approvati\n\n${approvedMd}\n\n# In attesa di approvazione\n\n${pendingMd}`
      : approvedMd || pendingMd;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast({ title: "Testo copiato", description: `${count} issue negli appunti.` });
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona il testo e copialo a mano." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Esporta issue: {CHAPTER_LABELS[chapter]}</DialogTitle>
          <DialogDescription>
            Testo in Markdown con titolo, contesto, cosa fare, criterio "pronto quando" e prove, da incollare nel repo
            dell'app.
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
              ? "Nessun elemento approvato o in attesa in questo capitolo."
              : "Nessun elemento approvato in questo capitolo: approvane qualcuno o includi quelli in attesa."}
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
