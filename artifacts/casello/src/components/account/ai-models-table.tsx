import { type FormEvent, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type AiAccount,
  type AiModel,
  type AiModelInput,
  type AiModelUpdate,
  getListAiAccountModelsQueryKey,
  useAddAiAccountModel,
  useListAiAccountModels,
  useProbeAiModel,
  useUpdateAiModel,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { invalidateAiQueries } from "@/components/ai/ai-queries";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatUsd } from "@/lib/format";

const MAX_PRICE = 999_999.999999;

const PRICE_SOURCE_LABELS: Record<string, string> = {
  provider: "dal provider",
  manual: "manuale",
  seed: "predefinito",
  catalog: "catalogo",
};

/** Stato effettivo dell'API ("unknown" di availability conta come disponibile: qui si usa solo `status`). */
function modelStatusLabel(model: AiModel): string {
  const base = model.status === "retired" ? "Ritirato" : model.status === "unavailable" ? "Non disponibile" : "Disponibile";
  return model.deprecationDate ? `${base}, dismesso il ${new Date(model.deprecationDate).toLocaleDateString("it-IT")}` : base;
}

function formatPrice(value: number | null): string {
  return value == null ? "—" : value.toLocaleString("it-IT", { maximumFractionDigits: 6 });
}

/** Prezzo scritto dall'utente: "" → null; accetta la virgola; undefined se non valido. */
function parsePrice(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : undefined;
}

/**
 * Prezzo modificabile in linea, salvato all'uscita dal campo. Se il salvataggio fallisce il campo torna al
 * valore salvato (onSave riceve la funzione che lo ripristina).
 */
function PriceInput({
  value,
  label,
  onSave,
}: {
  value: number | null;
  label: string;
  onSave: (value: number | null, restore: () => void) => void;
}) {
  const saved = value == null ? "" : String(value);
  const [text, setText] = useState(saved);
  const { toast } = useToast();
  const invalid = () => {
    toast({ variant: "destructive", title: "Prezzo non valido", description: "Inserisci un numero tra 0 e 999999." });
    setText(saved);
  };
  return (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      step="any"
      className="h-8 w-24 tabular-nums"
      aria-label={label}
      placeholder="—"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        // Testo non numerico ("-", "1e"): il browser riporta "" e non va scambiato per "prezzo vuoto"
        if (e.currentTarget.validity.badInput) return invalid();
        const parsed = parsePrice(text);
        if (parsed === undefined) return invalid();
        if (parsed !== value) onSave(parsed, () => setText(saved));
      }}
    />
  );
}

function AddModelForm({ accountId }: { accountId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [priceOutput, setPriceOutput] = useState("");

  const addModel = useAddAiAccountModel({
    mutation: {
      onSuccess: (model) => {
        void invalidateAiQueries(queryClient);
        setModelId("");
        setDisplayName("");
        setPriceInput("");
        setPriceOutput("");
        toast({ title: "Modello aggiunto", description: model.displayName });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Aggiunta non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const id = modelId.trim();
    const input = parsePrice(priceInput);
    const output = parsePrice(priceOutput);
    if (!id) return;
    if (input === undefined || output === undefined) {
      toast({ variant: "destructive", title: "Prezzo non valido", description: "Inserisci un numero tra 0 e 999999." });
      return;
    }
    const data: AiModelInput = { modelId: id };
    if (displayName.trim()) data.displayName = displayName.trim();
    if (input !== null) data.priceInput = input;
    if (output !== null) data.priceOutput = output;
    addModel.mutate({ id: accountId, data });
  };

  const prefix = `ai-add-model-${accountId}`;
  return (
    <form onSubmit={onSubmit} className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto] sm:items-end">
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-id`} className="text-xs">
          Id del modello
        </Label>
        <Input
          id={`${prefix}-id`}
          className="h-8"
          maxLength={256}
          placeholder="es. deepseek-chat"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-name`} className="text-xs">
          Nome (facoltativo)
        </Label>
        <Input
          id={`${prefix}-name`}
          className="h-8"
          maxLength={256}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-in`} className="text-xs">
          $ input / Mtok
        </Label>
        <Input
          id={`${prefix}-in`}
          type="number"
          min={0}
          step="any"
          className="h-8"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-out`} className="text-xs">
          $ output / Mtok
        </Label>
        <Input
          id={`${prefix}-out`}
          type="number"
          min={0}
          step="any"
          className="h-8"
          value={priceOutput}
          onChange={(e) => setPriceOutput(e.target.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={!modelId.trim() || addModel.isPending}>
        {addModel.isPending ? "Aggiunta…" : "Aggiungi modello"}
      </Button>
    </form>
  );
}

/** Modelli di un account: prezzi modificabili e "nascosto"; per l'account di sistema solo lettura. */
export function AiModelsTable({ account }: { account: AiAccount }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const readOnly = account.isSystem;
  const models = useListAiAccountModels(account.id, {
    query: { queryKey: getListAiAccountModelsQueryKey(account.id) },
  });

  const updateModel = useUpdateAiModel({
    mutation: {
      onSuccess: () => void invalidateAiQueries(queryClient),
      onError: (error) => {
        // Si rilegge lo stato salvato, così i campi tornano ai valori veri
        void invalidateAiQueries(queryClient);
        toast({ variant: "destructive", title: "Modifica non riuscita", description: apiErrorMessage(error) });
      },
    },
  });
  const probe = useProbeAiModel({
    mutation: {
      onSuccess: (result) => {
        void invalidateAiQueries(queryClient);
        if (result.ok) {
          const cost = result.costUsd != null ? formatUsd(result.costUsd) : "non noto";
          toast({ title: `Il modello risponde (costo ${cost})` });
        } else {
          toast({ variant: "destructive", title: "Il modello non risponde", description: result.error ?? undefined });
        }
      },
      onError: (error) =>
        toast({
          variant: "destructive",
          title: "Prova non riuscita",
          description:
            error instanceof ApiError && error.status === 429 ? "troppe prove: riprova tra un minuto" : apiErrorMessage(error),
        }),
    },
  });
  const save = (model: AiModel, data: AiModelUpdate, onError?: () => void) =>
    updateModel.mutate({ id: model.id, data }, { onError });

  return (
    <div className="space-y-3">
      {models.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare i modelli: {apiErrorMessage(models.error)}</p>
      ) : !models.data ? (
        <Skeleton className="h-20 w-full" />
      ) : models.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nessun modello.{readOnly ? "" : " Il provider potrebbe non fornire l'elenco: aggiungili a mano qui sotto."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Modello</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead className="text-right">Contesto</TableHead>
                <TableHead>$ input / Mtok</TableHead>
                <TableHead>$ output / Mtok</TableHead>
                <TableHead>Prezzo</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Strumenti</TableHead>
                <TableHead>Nascosto</TableHead>
                {!readOnly && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.data.map((model) => (
                <TableRow key={model.id} className={model.hidden ? "opacity-60" : undefined}>
                  <TableCell className="font-mono text-xs break-all">{model.modelId}</TableCell>
                  <TableCell className="text-sm">{model.displayName}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {model.contextTokens != null ? model.contextTokens.toLocaleString("it-IT") : "—"}
                  </TableCell>
                  <TableCell>
                    {readOnly ? (
                      <span className="text-sm tabular-nums">{formatPrice(model.priceInput)}</span>
                    ) : (
                      <PriceInput
                        // Rimontato quando il valore salvato cambia, così il campo lo rispecchia
                        key={`in-${model.priceInput}`}
                        value={model.priceInput}
                        label={`Prezzo di input di ${model.modelId}`}
                        onSave={(priceInput, restore) => save(model, { priceInput }, restore)}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    {readOnly ? (
                      <span className="text-sm tabular-nums">{formatPrice(model.priceOutput)}</span>
                    ) : (
                      <PriceInput
                        key={`out-${model.priceOutput}`}
                        value={model.priceOutput}
                        label={`Prezzo di output di ${model.modelId}`}
                        onSave={(priceOutput, restore) => save(model, { priceOutput }, restore)}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {model.priceSource ? PRICE_SOURCE_LABELS[model.priceSource] : "—"}
                  </TableCell>
                  <TableCell className="text-xs">{modelStatusLabel(model)}</TableCell>
                  <TableCell className="text-xs">
                    {model.supportsTools === null ? "?" : model.supportsTools ? "Sì" : "No"}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={model.hidden}
                      disabled={readOnly || updateModel.isPending}
                      aria-label={`Nascondi ${model.modelId}`}
                      onCheckedChange={(hidden) => save(model, { hidden })}
                    />
                  </TableCell>
                  {!readOnly && (
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={probe.isPending && probe.variables?.id === model.id}
                        onClick={() => probe.mutate({ id: model.id })}
                      >
                        {probe.isPending && probe.variables?.id === model.id ? "Prova…" : "Prova"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!readOnly && <AddModelForm accountId={account.id} />}
    </div>
  );
}
