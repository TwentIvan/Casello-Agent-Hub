import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type Node, getListNodesQueryKey, useUpdateNodeSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Led } from "@/components/brand/led";
import { apiErrorMessage } from "@/lib/api-errors";

interface FieldDef {
  key: "maxConcurrent" | "maxConcurrentTurns" | "taskTimeoutMinutes";
  label: string;
  min: number;
  max: number;
}

const FIELDS: FieldDef[] = [
  { key: "maxConcurrent", label: "Compiti in parallelo", min: 1, max: 3 },
  { key: "maxConcurrentTurns", label: "Turni in parallelo", min: 1, max: 4 },
  { key: "taskTimeoutMinutes", label: "Tempo massimo di un compito (minuti)", min: 5, max: 240 },
];

function SettingsForm({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  // Campo vuoto = «predefinito» (null)
  const [values, setValues] = useState<Record<FieldDef["key"], string>>(() => ({
    maxConcurrent: node.settings?.maxConcurrent?.toString() ?? "",
    maxConcurrentTurns: node.settings?.maxConcurrentTurns?.toString() ?? "",
    taskTimeoutMinutes: node.settings?.taskTimeoutMinutes?.toString() ?? "",
  }));
  const parsed = FIELDS.map((f) => {
    const raw = values[f.key].trim();
    if (raw === "") return { f, value: null as number | null, valid: true };
    const n = Number(raw);
    return { f, value: n, valid: Number.isInteger(n) && n >= f.min && n <= f.max };
  });
  const allValid = parsed.every((p) => p.valid);

  const save = useUpdateNodeSettings({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListNodesQueryKey() });
        onClose();
      },
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!allValid) return;
        const data = Object.fromEntries(parsed.map((p) => [p.f.key, p.value])) as {
          maxConcurrent: number | null;
          maxConcurrentTurns: number | null;
          taskTimeoutMinutes: number | null;
        };
        save.mutate({ id: node.id, data });
      }}
    >
      <DialogHeader>
        <DialogTitle>Impostazioni di {node.name}</DialogTitle>
        <DialogDescription>
          Il nodo le applica al prossimo contatto. Lascia vuoto un campo per usare il valore predefinito del nodo.
        </DialogDescription>
      </DialogHeader>
      {parsed.map(({ f, valid }) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`ns-${f.key}`}>{f.label}</Label>
          <Input
            id={`ns-${f.key}`}
            inputMode="numeric"
            className="font-mono"
            placeholder="predefinito"
            value={values[f.key]}
            aria-invalid={!valid}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">Da {f.min} a {f.max}.</p>
        </div>
      ))}
      {save.error && <Led state="ko" label={apiErrorMessage(save.error)} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Annulla
        </Button>
        <Button type="submit" disabled={!allValid || save.isPending}>
          {save.isPending ? "Salvataggio…" : "Salva impostazioni"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function NodeSettingsDialog({ node, onClose }: { node: Node | null; onClose: () => void }) {
  return (
    <Dialog open={node !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{node && <SettingsForm key={node.id} node={node} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}
