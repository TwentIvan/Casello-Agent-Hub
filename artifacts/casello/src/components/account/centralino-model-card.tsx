import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetCentralinoModelQueryKey, useGetCentralinoModel, useSetCentralinoModel } from "@workspace/api-client-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Modello del centralino: riassume lo stato delle squadre quando sono più di 5 (senza, vale il predefinito). */
export function CentralinoModelCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current = useGetCentralinoModel({ query: { queryKey: getGetCentralinoModelQueryKey() } });
  // undefined: nessuna modifica, vale il modello salvato
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const saved = current.data?.aiModelId ?? null;
  const value = chosen !== undefined ? chosen : saved;

  const save = useSetCentralinoModel({
    mutation: {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetCentralinoModelQueryKey(), result);
        setChosen(undefined);
        toast({ title: result.aiModelId === null ? "Modello del centralino tolto" : "Modello del centralino salvato" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Modello del centralino</CardTitle>
        <CardDescription>
          Il centralino riassume lo stato delle tue squadre quando sono più di cinque. Senza un modello scelto usa il
          modello predefinito.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {current.isError ? (
          <p className="text-sm text-destructive">
            Impossibile caricare il modello del centralino: {apiErrorMessage(current.error)}
          </p>
        ) : !current.data ? (
          <Skeleton className="h-9 w-full max-w-md" />
        ) : (
          <div className="flex flex-wrap items-start gap-2">
            <div className="w-full max-w-md">
              <ModelPicker id="centralino-model" value={value} onChange={setChosen} allowNone disabled={save.isPending} />
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
