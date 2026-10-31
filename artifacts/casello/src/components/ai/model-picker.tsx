import { useState } from "react";
import { Link } from "wouter";
import type { AiModel } from "@workspace/api-client-react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAiModelGroups } from "./ai-queries";

const NONE_LABEL = "Nessun modello";

interface ModelPickerProps {
  /** Id del modello (AiModel.id) scelto, null se nessuno. */
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  /** Mostra in cima la voce «Nessun modello» (onChange(null)), per i campi in cui l'assenza è una scelta valida. */
  allowNone?: boolean;
  /** Passati al trigger (es. da FormControl o per un Label con htmlFor). */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** Voce della lista: nome, id, prezzo e, se non noto, il "?" sul supporto agli strumenti. */
function ModelItem({ model, selected, onPick }: { model: AiModel; selected: boolean; onPick: () => void }) {
  return (
    <CommandItem value={`${model.displayName} ${model.modelId} #${model.id}`} onSelect={onPick}>
      <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
      <span className="min-w-0">
        <span>{model.displayName}</span>{" "}
        <span className="font-mono text-xs text-muted-foreground">({model.modelId})</span>
        <span className="text-xs text-muted-foreground">
          {" · "}
          {formatModelPrice(model.priceInput, model.priceOutput)}
        </span>
        {model.supportsTools === null && (
          <span className="ml-1 text-xs text-muted-foreground" title="supporto agli strumenti non noto">
            ?
          </span>
        )}
      </span>
    </CommandItem>
  );
}

/**
 * Tendina unica dei modelli: raggruppata per account, con prezzo per milione di token. Un modello che non è
 * tra quelli dell'utente (agente configurato da altri, modello nascosto o del vecchio gateway dismesso) resta
 * come voce disabilitata, così il valore non si perde.
 */
export function ModelPicker({ value, onChange, disabled, allowNone, id, ...aria }: ModelPickerProps) {
  const groups = useAiModelGroups();
  // null: nessuna scelta dell'utente, il gruppo "Altri modelli" è aperto se contiene il valore corrente
  const [othersToggled, setOthersToggled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  if (groups.isError) {
    return <p className="text-sm text-destructive">Impossibile caricare i modelli: {apiErrorMessage(groups.error)}</p>;
  }
  if (!groups.data) return <Skeleton className="h-9 w-full" />;

  const data = groups.data;
  // Solo i modelli selezionabili; quelli disponibili ma senza strumenti vanno in "Altri modelli"
  const main = data.map((g) => ({ group: g, models: g.models.filter((m) => m.selectable && m.supportsTools !== false) }));
  const others = data.flatMap((g) => g.models.filter((m) => m.status === "available" && m.supportsTools === false));
  const current = value != null ? data.flatMap((g) => g.models).find((m) => m.id === value) : undefined;
  // Valore corrente ritirato o non disponibile: resta come voce disabilitata
  const staleCurrent = current && current.status !== "available" ? current : undefined;
  const showOthers = othersToggled ?? (current !== undefined && others.includes(current));
  const known = current !== undefined;
  const foreign = value != null && !known;
  const hasModels = main.some((e) => e.models.length > 0) || others.length > 0;

  if (!hasModels && !foreign && !staleCurrent) {
    return (
      <p id={id} className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        Nessun modello: aggiungi un account AI dalla{" "}
        <Link href="/account" className="font-medium text-foreground underline underline-offset-2">
          pagina Account
        </Link>
      </p>
    );
  }

  const pick = (id: number | null) => {
    onChange(id);
    setOpen(false);
  };
  const triggerLabel = foreign
    ? `modello di un altro utente, nascosto o non più disponibile (#${value})`
    : current
      ? staleCurrent
        ? `${current.displayName} (${current.status === "retired" ? "ritirato" : "non disponibile"})`
        : current.displayName
      : null;

  return (
    <>
      {/* modal: dentro un Dialog la rotella scorre la lista */}
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-describedby={aria["aria-describedby"]}
            aria-invalid={aria["aria-invalid"]}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className={cn("truncate", triggerLabel === null && "text-muted-foreground")}>
              {triggerLabel ?? (allowNone ? NONE_LABEL : "Scegli un modello")}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
          <Command>
            <CommandInput placeholder="Cerca un modello…" />
            <CommandList>
              <CommandEmpty>Nessun modello trovato</CommandEmpty>
              {allowNone && (
                <>
                  <CommandGroup>
                    <CommandItem value={NONE_LABEL} onSelect={() => pick(null)}>
                      <Check className={cn("size-4", value === null ? "opacity-100" : "opacity-0")} />
                      <span className="text-muted-foreground">{NONE_LABEL}</span>
                    </CommandItem>
                  </CommandGroup>
                  <CommandSeparator />
                </>
              )}
              {(foreign || staleCurrent) && (
                <>
                  <CommandGroup>
                    <CommandItem value={`${triggerLabel} #${value}`} disabled>
                      {triggerLabel}
                    </CommandItem>
                  </CommandGroup>
                  <CommandSeparator />
                </>
              )}
              {main
                .filter((e) => e.models.length > 0)
                .map(({ group, models }) => (
                  <CommandGroup
                    key={group.account.id}
                    heading={
                      <span className="flex items-center gap-2">
                        <span className="truncate">{group.account.name}</span>
                        {group.account.status === "error" && <Badge variant="destructive">errore</Badge>}
                      </span>
                    }
                  >
                    {models.map((model) => (
                      <ModelItem key={model.id} model={model} selected={model.id === value} onPick={() => pick(model.id)} />
                    ))}
                  </CommandGroup>
                ))}
              {showOthers && others.length > 0 && (
                <CommandGroup heading="Altri modelli">
                  {others.map((model) => (
                    <ModelItem key={model.id} model={model} selected={model.id === value} onPick={() => pick(model.id)} />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {others.length > 0 && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1 h-auto p-0 text-xs"
          onClick={() => setOthersToggled(!showOthers)}
        >
          {showOthers ? "Nascondi altri modelli" : `Mostra altri modelli (${others.length})`}
        </Button>
      )}
    </>
  );
}
