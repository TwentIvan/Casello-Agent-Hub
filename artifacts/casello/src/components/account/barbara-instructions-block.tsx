import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { getGetAgentQueryKey, useGetAgent, useGetLeadChat, useUpdateAgent } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Istruzioni di Barbara, la Responsabile di Botcave: il prompt di sistema del suo agente. */
export function BarbaraInstructionsBlock() {
  const lead = useGetLeadChat();
  const agentId = lead.data?.available ? (lead.data.agentId ?? null) : null;
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-label">Istruzioni</h3>
        <p className="text-sm text-muted-foreground">
          Le istruzioni di Barbara, la Responsabile di Botcave, sono il prompt del suo agente.
        </p>
      </div>
      {lead.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare Barbara: {apiErrorMessage(lead.error)}</p>
      ) : !lead.data ? (
        <Skeleton className="h-32 w-full max-w-2xl" />
      ) : agentId === null ? (
        <p className="text-sm text-muted-foreground">{lead.data.reason ?? "Barbara non è disponibile."}</p>
      ) : (
        <BarbaraPrompt agentId={agentId} />
      )}
    </div>
  );
}

function BarbaraPrompt({ agentId }: { agentId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const key = getGetAgentQueryKey(agentId);
  const agent = useGetAgent(agentId, { query: { queryKey: key } });
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const save = useUpdateAgent({
    mutation: {
      onSuccess: (result) => {
        queryClient.setQueryData(key, result);
        setDraft(undefined);
        toast({ title: "Istruzioni di Barbara salvate" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  if (agent.isError) return <p className="text-sm text-destructive">{apiErrorMessage(agent.error)}</p>;
  if (!agent.data) return <Skeleton className="h-32 w-full max-w-2xl" />;
  const text = draft ?? agent.data.systemPrompt ?? "";
  const dirty = text !== (agent.data.systemPrompt ?? "");

  return (
    <div className="max-w-2xl space-y-3">
      <Textarea
        aria-label="Istruzioni di Barbara"
        rows={8}
        value={text}
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ id: agentId, data: { systemPrompt: text } })}>
          {save.isPending ? "Salvataggio…" : "Salva"}
        </Button>
        <Link href={`/agents/${agentId}`} className="text-sm font-medium underline">
          Apri l'agente di Barbara
        </Link>
      </div>
    </div>
  );
}
