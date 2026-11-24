import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Run,
  getListRunMessagesQueryKey,
  useCreateRunMessage,
  useListRunMessages,
} from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useLivePollInterval } from "@/components/live/live-updates";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { RUN_MESSAGE_MAX_CHARS, canInstruct, instructionError, runMessageView } from "@/lib/run-messages";
import { isRunActive } from "./run-queries";

const POLL_MS = 2000;

/**
 * Istruzioni a una run in corso (issue #119): l'utente corregge la rotta mentre l'agente lavora; il ciclo le legge tra un
 * passo e l'altro. Visibile con la run in esecuzione o se ha già ricevuto istruzioni.
 */
export function RunInstructions({ run }: { run: Run }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const active = isRunActive(run);
  const poll = useLivePollInterval(active ? POLL_MS : false);
  const messages = useListRunMessages(run.id, {
    query: { queryKey: getListRunMessagesQueryKey(run.id), refetchInterval: poll },
  });
  const create = useCreateRunMessage({
    mutation: {
      onSuccess: () => {
        setText("");
        void queryClient.invalidateQueries({ queryKey: getListRunMessagesQueryKey(run.id) });
      },
      onError: (error) => {
        toast({ variant: "destructive", title: "Istruzione non mandata", description: apiErrorMessage(error) });
      },
    },
  });

  const items = messages.data ?? [];
  const writable = canInstruct(run.status);
  if (!writable && items.length === 0) return null;
  const error = instructionError(text);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Istruzioni ({items.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length > 0 && (
          <ol className="space-y-2">
            {items.map((m) => {
              const view = runMessageView(m.status);
              return (
                <li key={m.id} className="space-y-1 text-sm">
                  <Led state={view.led} label={view.label} />
                  <p className="whitespace-pre-wrap break-words pl-4">{m.content}</p>
                </li>
              );
            })}
          </ol>
        )}
        {writable && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (error || create.isPending) return;
              create.mutate({ id: run.id, data: { content: text.trim() } });
            }}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Correggi la rotta: l'agente legge l'istruzione dopo il passo in corso"
              maxLength={RUN_MESSAGE_MAX_CHARS + 100}
              rows={3}
              aria-label="Istruzione per la run"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" disabled={Boolean(error) || create.isPending}>
                {create.isPending ? "Invio…" : "Manda l'istruzione"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Non dà permessi in più: le azioni L2 restano in «Da confermare».
              </span>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
