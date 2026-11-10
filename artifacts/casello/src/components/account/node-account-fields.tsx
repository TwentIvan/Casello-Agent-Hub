import { useAiModelGroups } from "@/components/ai/ai-queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const NONE = "none";

/** Modelli di ripiego possibili: dei propri account non nodo e selezionabili. */
export function useFallbackModelGroups() {
  const groups = useAiModelGroups();
  const data = (groups.data ?? [])
    .filter((g) => g.account.provider !== "claude_code_node")
    .map((g) => ({ account: g.account, models: g.models.filter((m) => m.selectable) }))
    .filter((g) => g.models.length > 0);
  return { ...groups, groups: data };
}

/** Scelta del modello di ripiego di un account Claude Code (nodo): «Nessuno» = null. */
export function FallbackModelSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}) {
  const { groups } = useFallbackModelGroups();
  return (
    <Select
      value={value === null ? NONE : String(value)}
      onValueChange={(v) => onChange(v === NONE ? null : Number(v))}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Nessuno" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Nessuno</SelectItem>
        {groups.map((g) =>
          g.models.map((m) => (
            <SelectItem key={m.id} value={String(m.id)}>
              {m.displayName} · {g.account.name}
            </SelectItem>
          )),
        )}
      </SelectContent>
    </Select>
  );
}
