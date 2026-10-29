import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  getListPlanConversationsQueryKey,
  useCreatePlanConversation,
  useListPlanConversations,
} from "@workspace/api-client-react";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatCost } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ConversationListProps {
  appId: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

/** Elenco delle conversazioni sul piano dell'app e dialogo per aprirne una nuova. */
export function ConversationList({ appId, selectedId, onSelect }: ConversationListProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const conversations = useListPlanConversations(appId, { query: { queryKey: getListPlanConversationsQueryKey(appId) } });
  const defaultModelId = useDefaultAiModelId();
  const [open, setOpen] = useState(false);
  const [chosenModelId, setChosenModelId] = useState<number | null>(null);
  const aiModelId = chosenModelId ?? defaultModelId;

  const create = useCreatePlanConversation({
    mutation: {
      onSuccess: (created) => {
        void queryClient.invalidateQueries({ queryKey: getListPlanConversationsQueryKey(appId) });
        setOpen(false);
        onSelect(created.id);
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Conversazione non creata", description: apiErrorMessage(error) }),
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Conversazioni</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setChosenModelId(null);
            setOpen(true);
          }}
        >
          <Plus />
          Nuova conversazione
        </Button>
      </div>

      {conversations.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare le conversazioni: {apiErrorMessage(conversations.error)}</p>
      ) : !conversations.data ? (
        <Skeleton className="h-16 w-full" />
      ) : conversations.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nessuna conversazione: aprine una per chiedere integrazioni al piano.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {conversations.data.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={c.id === selectedId ? "true" : undefined}
                className={cn(
                  "block w-full space-y-0.5 p-3 text-left text-sm hover:bg-muted/50",
                  c.id === selectedId && "bg-muted",
                )}
              >
                <span className="block truncate font-medium">{c.title}</span>
                <span className="block text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(c.updatedAt)}
                  {formatCost(c.costUsd, c.tokensUsed) ? ` · ${formatCost(c.costUsd, c.tokensUsed)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuova conversazione</DialogTitle>
            <DialogDescription>
              Scegli il modello che risponderà: il costo dei suoi turni è a carico del tuo account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="plan-model">Modello</Label>
            <ModelPicker id="plan-model" value={aiModelId} onChange={setChosenModelId} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>
              Annulla
            </Button>
            <Button
              disabled={aiModelId === null || create.isPending}
              onClick={() => aiModelId !== null && create.mutate({ id: appId, data: { aiModelId } })}
            >
              {create.isPending ? "Creazione…" : "Crea"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
