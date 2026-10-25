import { useState } from "react";
import type { AnalysisItem } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { isRecord, itemTitle, prettyJson } from "@/components/analysis/payload";

interface ItemEditDialogProps {
  item: AnalysisItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  /** Salva il payload; con `approve` lo approva nella stessa richiesta. Il chiamante chiude a esito riuscito. */
  onSubmit: (payload: Record<string, unknown>, approve: boolean) => void;
}

/** Modifica del payload di un elemento in attesa: JSON controllato qui, validato dall'API al salvataggio. */
export function ItemEditDialog({ item, open, onOpenChange, pending, onSubmit }: ItemEditDialogProps) {
  const [text, setText] = useState(() => prettyJson(item.payload));
  const [error, setError] = useState<string | null>(null);

  const submit = (approve: boolean) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("JSON non valido: controlla virgole, virgolette e parentesi.");
      return;
    }
    if (!isRecord(parsed)) {
      setError("Il contenuto deve essere un oggetto JSON (tra parentesi graffe).");
      return;
    }
    setError(null);
    onSubmit(parsed, approve);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Modifica «{itemTitle(item)}»</DialogTitle>
          <DialogDescription>
            Il contenuto della proposta in JSON. Al salvataggio viene controllato con le stesse regole dell'architetto.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            rows={20}
            spellCheck={false}
            aria-invalid={error !== null}
            className="max-h-[60vh] min-h-64 font-mono text-xs leading-relaxed"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Annulla
          </Button>
          <Button variant="secondary" onClick={() => submit(false)} disabled={pending}>
            {pending ? "Salvataggio…" : "Salva"}
          </Button>
          <Button onClick={() => submit(true)} disabled={pending}>
            Salva e approva
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
