import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  type CharacterSettingsView,
  getGetAlfredSettingsQueryKey,
  getGetCharacterSettingsQueryKey,
  useGetAlfredSettings,
  useGetCharacterSettings,
  useSetAlfredSettings,
  useUpdateCharacterSettings,
} from "@workspace/api-client-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { CapForm, ratio, SpendLine, WARN_RATIO } from "@/components/budget/budget";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatUsd } from "@/lib/format";

const VOICES = ["Kore", "Charon", "Aoede", "Puck", "Fenrir", "Leda", "Orus", "Zephyr"];

type Character = "alfred" | "lucius";

/** Avviso dall'80% del tetto del personaggio, con lo stile degli avvisi di tetto della dashboard. */
function CapWarning({ name, spent, cap }: { name: string; spent: number; cap: number | null }) {
  const r = ratio(spent, cap);
  if (r === null || r < WARN_RATIO) return null;
  const exhausted = r >= 1;
  return (
    <Alert variant={exhausted ? "destructive" : "default"}>
      <AlertTriangle className="size-4" />
      <AlertTitle>{exhausted ? `Tetto di ${name} raggiunto` : `Tetto di ${name} quasi raggiunto`}</AlertTitle>
      <AlertDescription>
        Questo mese {name} ha speso {formatUsd(spent)} su {formatUsd(cap!)} ({Math.round(r * 100)}%).
        {exhausted && " Alza il tetto o attendi il mese prossimo: nel frattempo non parte nulla di nuovo."}
      </AlertDescription>
    </Alert>
  );
}

/** Voce di Alfred (Gemini Live): modello vocale e voce. */
function AlfredVoiceBlock() {
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
        toast({ title: "Impostazioni della voce di Alfred salvate" });
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
    <div className="space-y-4">
      <div>
        <h3 className="text-label">A voce</h3>
        <p className="text-sm text-muted-foreground">
          Parli con un modello vocale Gemini dei tuoi account AI e Alfred consulta le tue squadre. La conversazione costa
          sul tuo account.
        </p>
      </div>
      {current.isError ? (
        <p className="text-sm text-destructive">Impossibile caricare la voce di Alfred: {apiErrorMessage(current.error)}</p>
      ) : !data ? (
        <Skeleton className="h-9 w-full max-w-md" />
      ) : data.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aggiungi un account Gemini e scegli un modello vocale.</p>
      ) : (
        <>
          <div className="grid max-w-md gap-2">
            <Label htmlFor="alfred-model">Modello vocale</Label>
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
              {save.isPending ? "Salvataggio…" : "Salva la voce"}
            </Button>
            <Link href="/alfred" className="text-sm font-medium underline">
              Apri Alfred
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

/** Modello e tetto di un personaggio per le conversazioni scritte; il PUT sostituisce tutti e quattro i campi. */
function WrittenBlock({ character, settings }: { character: Character; settings: CharacterSettingsView }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isAlfred = character === "alfred";
  const name = isAlfred ? "Alfred" : "Lucius";
  const savedModel = isAlfred ? settings.alfredChatAiModelId : settings.luciusAiModelId;
  const cap = isAlfred ? settings.alfredMonthlyBudgetUsd : settings.luciusMonthlyBudgetUsd;
  const spent = isAlfred ? settings.alfredSpentUsd : settings.luciusSpentUsd;
  const unpriced = isAlfred ? settings.alfredUnpricedCount : settings.luciusUnpricedCount;
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const modelValue = chosen !== undefined ? chosen : savedModel;

  const update = useUpdateCharacterSettings({
    mutation: {
      onSuccess: (result) => {
        // La risposta del PUT è la vista completa, con la spesa
        queryClient.setQueryData(getGetCharacterSettingsQueryKey(), result);
        toast({ title: `Impostazioni di ${name} salvate` });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  // Sempre tutti e quattro i valori: gli altri restano quelli salvati
  const send = (next: { model?: number | null; cap?: number | null }) => {
    const model = next.model !== undefined ? next.model : savedModel;
    const newCap = next.cap !== undefined ? next.cap : cap;
    update.mutate(
      {
        data: {
          alfredChatAiModelId: isAlfred ? model : settings.alfredChatAiModelId,
          luciusAiModelId: isAlfred ? settings.luciusAiModelId : model,
          alfredMonthlyBudgetUsd: isAlfred ? newCap : settings.alfredMonthlyBudgetUsd,
          luciusMonthlyBudgetUsd: isAlfred ? settings.luciusMonthlyBudgetUsd : newCap,
        },
      },
      {
        // Una scelta di modello non ancora salvata si perde solo se si è salvato il modello
        onSuccess: () => {
          if (next.model !== undefined) setChosen(undefined);
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <div>
        {isAlfred && <h3 className="text-label">Per iscritto</h3>}
        <p className="text-sm text-muted-foreground">
          {isAlfred
            ? "Il modello delle conversazioni scritte con Alfred. Le nuove conversazioni partono da qui."
            : "Il modello delle conversazioni con Lucius: chat del piano, della squadra e delle aree. Le nuove conversazioni partono da qui."}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <div className="w-full max-w-md">
          <ModelPicker
            id={`${character}-written-model`}
            value={modelValue}
            onChange={setChosen}
            allowNone
            disabled={update.isPending}
          />
        </div>
        <Button disabled={modelValue === savedModel || update.isPending} onClick={() => send({ model: modelValue })}>
          {update.isPending ? "Salvataggio…" : `Salva il modello di ${name}`}
        </Button>
      </div>
      <div className="space-y-3">
        <p className="text-label">Tetto di spesa di {name}</p>
        <SpendLine spent={spent} cap={cap} unpriced={unpriced} />
        <CapForm
          key={String(cap)}
          value={cap}
          pending={update.isPending}
          label={`Tetto mensile in USD di ${name}`}
          onSave={(next) => send({ cap: next })}
        />
        <CapWarning name={name} spent={spent} cap={cap} />
      </div>
    </div>
  );
}

/** Account → Personaggi: Alfred (voce, modello scritto, tetto) e Lucius (modello, tetto). */
export function CharactersSection() {
  const settings = useGetCharacterSettings({ query: { queryKey: getGetCharacterSettingsQueryKey() } });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personaggi</CardTitle>
        <CardDescription>
          Alfred, il maggiordomo, segue squadre, coda e run; Lucius, l'ingegnere del laboratorio, lavora su piano, agenti,
          skill e modelli di squadra. Ognuno ha il suo modello e un tetto mensile facoltativo: la spesa conta sui tuoi
          account AI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <section className="space-y-6" aria-labelledby="characters-alfred">
          <h2 id="characters-alfred" className="text-h2">
            Alfred
          </h2>
          <AlfredVoiceBlock />
          {settings.isError ? (
            <p className="text-sm text-destructive">Impossibile caricare le impostazioni: {apiErrorMessage(settings.error)}</p>
          ) : !settings.data ? (
            <Skeleton className="h-24 w-full max-w-md" />
          ) : (
            <WrittenBlock character="alfred" settings={settings.data} />
          )}
        </section>
        {settings.data && (
          <section className="space-y-6" aria-labelledby="characters-lucius">
            <h2 id="characters-lucius" className="text-h2">
              Lucius
            </h2>
            <WrittenBlock character="lucius" settings={settings.data} />
          </section>
        )}
      </CardContent>
    </Card>
  );
}
