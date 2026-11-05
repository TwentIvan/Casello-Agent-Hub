import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getGetAlfredSettingsQueryKey, useGetAlfredSettings, useSetAlfredSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const VOICES = ["Kore", "Charon", "Aoede", "Puck", "Fenrir", "Leda", "Orus", "Zephyr"];

/** Alfred, il maggiordomo vocale: modello (un modello vocale Gemini dei propri account) e voce. */
export function AlfredSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current = useGetAlfredSettings({ query: { queryKey: getGetAlfredSettingsQueryKey() } });
  // undefined: nessuna modifica, vale il valore salvato
  const [model, setModel] = useState<number | null | undefined>(undefined);
  const [voice, setVoice] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useSetAlfredSettings({
    mutation: {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetAlfredSettingsQueryKey(), result);
        setModel(undefined);
        setVoice(undefined);
        setSaveError(null);
        toast({ title: "Impostazioni di Alfred salvate" });
      },
      onError: (error) => setSaveError(apiErrorMessage(error)),
    },
  });

  const data = current.data;
  const savedModel = data?.aiModelId ?? null;
  const modelValue = model !== undefined ? model : savedModel;
  const voiceValue = voice ?? data?.voice ?? "Kore";
  const dirty = data !== undefined && (modelValue !== savedModel || voiceValue !== data.voice);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alfred</CardTitle>
        <CardDescription>
          Il maggiordomo vocale: parli con un modello vocale Gemini dei tuoi account AI e lui consulta le tue squadre. La
          conversazione costa sul tuo account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {current.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare Alfred: {apiErrorMessage(current.error)}</p>
        ) : !data ? (
          <Skeleton className="h-9 w-full max-w-md" />
        ) : data.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aggiungi un account Gemini e scegli un modello vocale.</p>
        ) : (
          <>
            <div className="grid max-w-md gap-2">
              <Label htmlFor="alfred-model">Modello</Label>
              <Select
                value={modelValue === null ? undefined : String(modelValue)}
                onValueChange={(v) => setModel(Number(v))}
                disabled={save.isPending}
              >
                <SelectTrigger id="alfred-model">
                  <SelectValue placeholder="Scegli un modello" />
                </SelectTrigger>
                <SelectContent>
                  {data.models.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name} · {m.accountName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid max-w-md gap-2">
              <Label htmlFor="alfred-voice">Voce</Label>
              <Select value={voiceValue} onValueChange={setVoice} disabled={save.isPending}>
                <SelectTrigger id="alfred-voice">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setSaveError(null);
                  save.mutate({ data: { aiModelId: modelValue, voice: voiceValue } });
                }}
              >
                {save.isPending ? "Salvataggio…" : "Salva"}
              </Button>
              <Link href="/alfred" className="text-sm font-medium underline">
                Apri Alfred
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
