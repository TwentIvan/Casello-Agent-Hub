import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetDefaultModelQueryKey, useGetDefaultModel, useSetDefaultModel } from "@workspace/api-client-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Modello predefinito dell'utente: precompila il modello degli agenti che Casello crea. */
export function DefaultModelCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current = useGetDefaultModel({ query: { queryKey: getGetDefaultModelQueryKey() } });
  // undefined: nessuna modifica, vale il predefinito salvato
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const saved = current.data?.aiModelId ?? null;
  const value = chosen !== undefined ? chosen : saved;

  const save = useSetDefaultModel({
    mutation: {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetDefaultModelQueryKey(), result);
        setChosen(undefined);
        toast({ title: result.aiModelId === null ? "Modello predefinito tolto" : "Modello predefinito salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modello predefinito</CardTitle>
        <CardDescription>
          Precompila il modello degli agenti che Casello crea: l'agente generale di una nuova app, gli agenti approvati
          dall'architetto e quelli creati a mano. Puoi sempre cambiarlo agente per agente.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {current.isError ? (
          <p className="text-sm text-destructive">
            Impossibile caricare il modello predefinito: {apiErrorMessage(current.error)}
          </p>
        ) : !current.data ? (
          <Skeleton className="h-9 w-full max-w-md" />
        ) : (
          <div className="flex flex-wrap items-start gap-2">
            <div className="w-full max-w-md">
              <ModelPicker id="default-model" value={value} onChange={setChosen} allowNone disabled={save.isPending} />
            </div>
            <Button
              disabled={value === saved || save.isPending}
              onClick={() => save.mutate({ data: { aiModelId: value } })}
            >
              {save.isPending ? "Salvataggio…" : "Salva"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
