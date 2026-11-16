import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  type EvolutionCycleView,
  type EvolutionFrequency,
  getGetAppEvolutionQueryKey,
  getGetDashboardStatsQueryKey,
  useGetAppEvolutionConsentText,
  useSaveAppEvolution,
} from "@workspace/api-client-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { canActivate, FREQUENCY_LABELS } from "@/lib/evolution-consent";

interface Props {
  app: App;
  cycle: EvolutionCycleView | null;
  /** true = «Attiva…» (con consenso), false = «Impostazioni…» di un ciclo già consentito */
  activating: boolean;
  onClose: () => void;
}

/** Impostazioni del ciclo di evoluzione e, all'attivazione, il consenso esplicito dell'utente. */
export function EvolutionConsentDialog({ app, cycle, activating, onClose }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [frequency, setFrequency] = useState<EvolutionFrequency>(cycle?.frequency ?? "weekly");
  const [itemsPerRound, setItemsPerRound] = useState(String(cycle?.itemsPerRound ?? 3));
  const [modelId, setModelId] = useState<number | null>(cycle?.analysisAiModelId ?? null);
  const [budget, setBudget] = useState(String(cycle?.monthlyBudgetUsd ?? 10));
  const [accepted, setAccepted] = useState(false);
  const [typedSlug, setTypedSlug] = useState("");

  const items = Number(itemsPerRound);
  const budgetNum = Number(budget);
  const itemsValid = Number.isInteger(items) && items >= 1 && items <= 20;
  const budgetValid = budget.trim() !== "" && Number.isFinite(budgetNum) && budgetNum > 0;
  const settingsValid = itemsValid && budgetValid && modelId !== null;

  const consent = useGetAppEvolutionConsentText(
    app.id,
    { mergeMode: "direct", analysisAiModelId: modelId ?? 0, itemsPerRound: itemsValid ? items : 1, monthlyBudgetUsd: budgetValid ? budgetNum : 1 },
    { query: { queryKey: ["evolution-consent-text", app.id, modelId, items, budgetNum], enabled: activating && settingsValid } },
  );

  const save = useSaveAppEvolution({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAppEvolutionQueryKey(app.id) });
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        toast({ title: activating ? "Ciclo attivato" : "Impostazioni salvate" });
        onClose();
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const consentVersion = consent.data?.version;
  const canSubmit =
    settingsValid &&
    !save.isPending &&
    (!activating ||
      (consentVersion !== undefined &&
        canActivate({ accepted, typedSlug, appSlug: app.slug, mergeMode: "direct", directAccepted: true })));

  const submit = () => {
    if (modelId === null) return;
    save.mutate({
      id: app.id,
      data: {
        frequency,
        itemsPerRound: items,
        analysisAiModelId: modelId,
        teamTemplateId: null,
        mergeMode: "direct",
        stagingBranch: null,
        stagingUrl: null,
        monthlyBudgetUsd: budgetNum,
        ...(activating && consentVersion !== undefined
          ? { consent: { accepted: true, appSlug: app.slug, version: consentVersion } }
          : {}),
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{activating ? "Attiva l'evoluzione automatica" : "Impostazioni dell'evoluzione automatica"}</DialogTitle>
          <DialogDescription>Ogni giro analizza l'app, sceglie alcune voci del piano e le fa implementare alla squadra.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Frequenza</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as EvolutionFrequency)}>
                <SelectTrigger aria-label="Frequenza dei giri">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FREQUENCY_LABELS) as EvolutionFrequency[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {FREQUENCY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="evo-items">Voci per giro (1–20)</Label>
              <Input id="evo-items" inputMode="numeric" value={itemsPerRound} onChange={(e) => setItemsPerRound(e.target.value)} aria-invalid={!itemsValid} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="evo-model">Modello per l'analisi e la scelta</Label>
              <ModelPicker id="evo-model" cloudOnly value={modelId} onChange={setModelId} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="evo-budget">Tetto mensile (USD)</Label>
              <Input id="evo-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={!budgetValid} />
            </div>
          </div>

          {activating && (
            <div className="min-w-0 space-y-3 rounded-md border border-border bg-surface-1 p-3">
              {!settingsValid && <p className="text-sm text-ink-muted">Scegli un modello e valori validi per leggere il consenso.</p>}
              {settingsValid && consent.isLoading && <p className="text-sm text-ink-muted">Caricamento…</p>}
              {consent.isError && <p className="text-sm text-danger">{apiErrorMessage(consent.error)}</p>}
              {consent.data && (
                <ul className="list-disc space-y-1.5 pl-5 text-sm break-words">
                  {consent.data.lines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              )}
              <div className="flex items-start gap-2">
                <Checkbox id="evo-accept" checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} />
                <Label htmlFor="evo-accept" className="leading-snug">
                  Attivo a mio rischio
                </Label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="evo-slug">
                  Scrivi lo slug dell'app per confermare: <span className="font-mono">{app.slug}</span>
                </Label>
                <Input id="evo-slug" value={typedSlug} onChange={(e) => setTypedSlug(e.target.value)} autoComplete="off" />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {activating ? "Attiva il ciclo" : "Salva le impostazioni"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
