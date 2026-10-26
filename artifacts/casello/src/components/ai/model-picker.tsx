import { Link } from "wouter";
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

/**
 * Tendina unica dei modelli: raggruppata per account, con prezzo per milione di token. Un modello che non è
 * tra quelli dell'utente (agente configurato da altri, modello nascosto o account di sistema dismesso) resta
 * come voce disabilitata, così il valore non si perde.
 */
export function ModelPicker({ value, onChange, disabled, id, ...aria }: ModelPickerProps) {
  const groups = useAiModelGroups();

  if (groups.isError) {
    return <p className="text-sm text-destructive">Impossibile caricare i modelli: {apiErrorMessage(groups.error)}</p>;
  }
  if (!groups.data) return <Skeleton className="h-9 w-full" />;

  const data = groups.data;
  const known = data.some((g) => g.models.some((m) => m.id === value));
  const foreign = value != null && !known;
  // L'account di sistema compare nei gruppi solo finché è configurato: se manca, un modello sconosciuto è
  // con ogni probabilità un collegamento al vecchio gateway rimasto senza account
  const systemAvailable = data.some((g) => g.account.isSystem);
  const hasModels = data.some((g) => g.models.length > 0);

  if (!hasModels && !foreign) {
    return (
      <p id={id} className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        Nessun modello: aggiungi un account AI dalla{" "}
        <Link href="/account" className="font-medium text-foreground underline underline-offset-2">
          pagina Account
        </Link>
      </p>
    );
  }

  return (
    <Select
      value={value != null ? String(value) : ""}
      onValueChange={(v) => onChange(v ? Number(v) : null)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-describedby={aria["aria-describedby"]} aria-invalid={aria["aria-invalid"]}>
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
        {data
          .filter((g) => g.models.length > 0)
          .map((group, index) => (
            <SelectGroup key={group.account.id}>
              {index > 0 && <SelectSeparator />}
              <SelectLabel className="flex items-center gap-2">
                <span className="truncate">{group.account.name}</span>
                {group.account.isSystem && <Badge variant="secondary">sistema</Badge>}
                {group.account.status === "error" && <Badge variant="destructive">errore</Badge>}
              </SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={model.id} value={String(model.id)}>
                  <span>{model.displayName}</span>{" "}
                  <span className="font-mono text-xs text-muted-foreground">({model.modelId})</span>
                  <span className="text-xs text-muted-foreground">
                    {" · "}
                    {formatModelPrice(model.priceInput, model.priceOutput)}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
      </SelectContent>
    </Select>
  );
}
