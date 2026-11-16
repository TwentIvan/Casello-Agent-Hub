import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ConvSummary } from "./adapters";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

interface ChatToolbarProps {
  /** null = filo unico (Alfred): niente elenco né «Nuova». */
  conversations: ConvSummary[] | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
  disabled: boolean;
  running: boolean;
  canCreate: boolean;
  canDelete: boolean;
  canRestart: boolean;
  onCreate: () => void;
  onDelete: () => void;
  onRestart: () => void;
  /** Solo Lucius: interruttore delle best practice della conversazione aperta. */
  bestPractice?: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void };
}

/** Scelta della conversazione dell'argomento, «Nuova», elimina; per Alfred «Ricomincia». */
export function ChatToolbar(props: ChatToolbarProps) {
  const { conversations, selectedId, onSelect, disabled, running } = props;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {conversations && conversations.length > 0 && (
        <Select value={selectedId !== null ? String(selectedId) : undefined} onValueChange={(v) => onSelect(Number(v))}>
          <SelectTrigger className="h-8 min-w-0 flex-1 basis-40" aria-label="Conversazione">
            <SelectValue placeholder="Conversazione" />
          </SelectTrigger>
          <SelectContent>
            {conversations.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                <span className="block max-w-[18rem] truncate">
                  {c.title || "Nuova conversazione"} · {formatDateTime(c.updatedAt)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {conversations && props.canCreate && (
        <Button size="sm" variant="outline" disabled={disabled} onClick={props.onCreate}>
          <Plus />
          Nuova
        </Button>
      )}
      {conversations && props.canDelete && (
        <Button
          size="sm"
          variant="ghost"
          aria-label="Elimina la conversazione"
          title="Elimina la conversazione"
          disabled={disabled || running}
          onClick={props.onDelete}
        >
          <Trash2 />
        </Button>
      )}
      {props.canRestart && (
        <Button size="sm" variant="outline" disabled={disabled || running} onClick={props.onRestart}>
          <RotateCcw />
          Ricomincia
        </Button>
      )}
      {props.bestPractice && (
        <div
          className="flex items-center gap-2"
          title="Prima di proporre, Lucius cerca le best practice per app simili"
        >
          <Switch
            id="chat-best-practice"
            checked={props.bestPractice.checked}
            disabled={props.bestPractice.disabled}
            onCheckedChange={props.bestPractice.onChange}
          />
          <Label htmlFor="chat-best-practice" className="text-sm">
            Best practice
          </Label>
        </div>
      )}
    </div>
  );
}
