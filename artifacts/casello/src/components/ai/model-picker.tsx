import { useState } from "react";
import { Link } from "wouter";
import type { AiModel } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatModelPrice } from "@/lib/format";
import { useAiModelGroups } from "./ai-queries";

interface ModelPickerProps {
  /** Id del modello (AiModel.id) scelto, null se nessuno. */
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  /** Passati al trigger (es. da FormControl o per un Label con htmlFor). */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** Voce della tendina: nome, id, prezzo e, se non noto, il "?" sul supporto agli strumenti. */
function ModelItem({ model }: { model: AiModel }) {
  return (
    <SelectItem value={String(model.id)}>
      <span>{model.displayName}</span>{" "}
      <span className="font-mono text-xs text-muted-foreground">
        ({model.modelId})
      </span>
      <span className="text-xs text-muted-foreground">
        {" · "}
        {formatModelPrice(model.priceInput, model.priceOutput)}
      </span>
      {model.supportsTools === null && (
        <span
          className="ml-1 text-xs text-muted-foreground"
          title="supporto agli strumenti non noto"
        >
          ?
        </span>
      )}
    </SelectItem>
  );
}

/**
 * Tendina unica dei modelli: raggruppata per account, con prezzo per milione di token. Un modello che non è
 * tra quelli dell'utente (agente configurato da altri, modello nascosto o account di sistema dismesso) resta
 * come voce disabilitata, così il valore non si perde.
 */
export function ModelPicker({
  value,
  onChange,
  disabled,
  id,
  ...aria
}: ModelPickerProps) {
  const groups = useAiModelGroups();
  const [showOthers, setShowOthers] = useState(false);

  if (groups.isError) {
    return (
      <p className="text-sm text-destructive">
        Impossibile caricare i modelli: {apiErrorMessage(groups.error)}
      </p>
    );
  }
  if (!groups.data) return <Skeleton className="h-9 w-full" />;

  const data = groups.data;
  // Solo i modelli selezionabili; quelli senza strumenti vanno in "Altri modelli"
  const main = data.map((g) => ({
    group: g,
    models: g.models.filter((m) => m.selectable && m.supportsTools !== false),
  }));
  const others = data.flatMap((g) =>
    g.models.filter((m) => m.selectable && m.supportsTools === false),
  );
  const current =
    value != null
      ? data.flatMap((g) => g.models).find((m) => m.id === value)
      : undefined;
  // Valore corrente ritirato o non disponibile: resta come voce disabilitata
  const staleCurrent = current && !current.selectable ? current : undefined;
  const known = current !== undefined;
  const foreign = value != null && !known;
  // L'account di sistema compare nei gruppi solo finché è configurato: se manca, un modello sconosciuto è
  // con ogni probabilità un collegamento al vecchio gateway rimasto senza account
  const systemAvailable = data.some((g) => g.account.isSystem);
  const hasModels = main.some((e) => e.models.length > 0) || others.length > 0;

  if (!hasModels && !foreign && !staleCurrent) {
    return (
      <p
        id={id}
        className="rounded-md border border-dashed p-3 text-sm text-muted-foreground"
      >
        Nessun modello: aggiungi un account AI dalla{" "}
        <Link
          href="/account"
          className="font-medium text-foreground underline underline-offset-2"
        >
          pagina Account
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <Select
        value={value != null ? String(value) : ""}
        onValueChange={(v) => onChange(v ? Number(v) : null)}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          aria-describedby={aria["aria-describedby"]}
          aria-invalid={aria["aria-invalid"]}
        >
          <SelectValue placeholder="Scegli un modello" />
        </SelectTrigger>
        <SelectContent>
          {foreign && (
            <>
              <SelectItem value={String(value)} disabled>
                {systemAvailable
                  ? `modello di un altro utente o nascosto (#${value})`
                  : `account di sistema non più disponibile (#${value})`}
              </SelectItem>
              <SelectSeparator />
            </>
          )}
          {staleCurrent && (
            <>
              <SelectItem value={String(staleCurrent.id)} disabled>
                {staleCurrent.displayName} (
                {staleCurrent.status === "retired"
                  ? "ritirato"
                  : "non disponibile"}
                )
              </SelectItem>
              <SelectSeparator />
            </>
          )}
          {main
            .filter((e) => e.models.length > 0)
            .map(({ group, models }, index) => (
              <SelectGroup key={group.account.id}>
                {index > 0 && <SelectSeparator />}
                <SelectLabel className="flex items-center gap-2">
                  <span className="truncate">{group.account.name}</span>
                  {group.account.isSystem && (
                    <Badge variant="secondary">sistema</Badge>
                  )}
                  {group.account.status === "error" && (
                    <Badge variant="destructive">errore</Badge>
                  )}
                </SelectLabel>
                {models.map((model) => (
                  <ModelItem key={model.id} model={model} />
                ))}
              </SelectGroup>
            ))}
          {showOthers && others.length > 0 && (
            <SelectGroup>
              <SelectSeparator />
              <SelectLabel>Altri modelli</SelectLabel>
              {others.map((model) => (
                <ModelItem key={model.id} model={model} />
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      {others.length > 0 && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setShowOthers((v) => !v)}
        >
          {showOthers
            ? "Nascondi altri modelli"
            : `Mostra altri modelli (${others.length})`}
        </Button>
      )}
    </div>
  );
}
