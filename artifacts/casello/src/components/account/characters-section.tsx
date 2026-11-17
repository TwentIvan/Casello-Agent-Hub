import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  type CharacterSettings,
  type CharacterSettingsView,
  getGetAlfredSettingsQueryKey,
  getGetCharacterSettingsQueryKey,
  useGetAlfredSettings,
  useGetCharacterSettings,
  useSetAlfredSettings,
  useUpdateCharacterSettings,
} from "@workspace/api-client-react";
import { BarbaraInstructionsBlock } from "@/components/account/barbara-instructions-block";
import { PersonalInstructionsBlock } from "@/components/account/personal-instructions-block";
import { ModelPicker } from "@/components/ai/model-picker";
import { CapForm, ratio, SpendLine, WARN_RATIO } from "@/components/budget/budget";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatUsd } from "@/lib/format";
import { MAX_CURATED_SOURCES, validateCuratedSources, type CuratedSourceRow } from "@/lib/curated-sources";

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

/** Salva una parte delle impostazioni dei personaggi; `onSaved` dopo il successo. */
type SaveSettings = (patch: Partial<CharacterSettings>, name: string, onSaved?: () => void) => void;

/** Modello e tetto di un personaggio per le conversazioni scritte (il salvataggio è uno solo per i due blocchi). */
function WrittenBlock({
  character,
  settings,
  save,
  pending,
}: {
  character: Character;
  settings: CharacterSettingsView;
  save: SaveSettings;
  pending: boolean;
}) {
  const isAlfred = character === "alfred";
  const name = isAlfred ? "Alfred" : "Lucius";
  const savedModel = isAlfred ? settings.alfredChatAiModelId : settings.luciusAiModelId;
  const cap = isAlfred ? settings.alfredMonthlyBudgetUsd : settings.luciusMonthlyBudgetUsd;
  const spent = isAlfred ? settings.alfredSpentUsd : settings.luciusSpentUsd;
  const unpriced = isAlfred ? settings.alfredUnpricedCount : settings.luciusUnpricedCount;
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const modelValue = chosen !== undefined ? chosen : savedModel;

  const send = (next: { model?: number | null; cap?: number | null }) => {
    const patch: Partial<CharacterSettings> = {};
    if (next.model !== undefined) patch[isAlfred ? "alfredChatAiModelId" : "luciusAiModelId"] = next.model;
    if (next.cap !== undefined) patch[isAlfred ? "alfredMonthlyBudgetUsd" : "luciusMonthlyBudgetUsd"] = next.cap;
    // Una scelta di modello non ancora salvata si perde solo se si è salvato il modello
    save(patch, name, next.model !== undefined ? () => setChosen(undefined) : undefined);
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
            disabled={pending}
          />
        </div>
        <Button disabled={modelValue === savedModel || pending} onClick={() => send({ model: modelValue })}>
          {pending ? "Salvataggio…" : `Salva il modello di ${name}`}
        </Button>
      </div>
      <div className="space-y-3">
        <p className="text-label">Tetto di spesa di {name}</p>
        <SpendLine spent={spent} cap={cap} unpriced={unpriced} />
        <CapForm
          key={String(cap)}
          value={cap}
          pending={pending}
          label={`Tetto mensile in USD di ${name}`}
          onSave={(next) => send({ cap: next })}
        />
        <CapWarning name={name} spent={spent} cap={cap} />
      </div>
    </div>
  );
}

const NO_MODEL = "none";

/** Best practice di Lucius: quando cercarle, modello Gemini della ricerca e fonti curate. */
function BestPracticeBlock({
  settings,
  save,
  pending,
}: {
  settings: CharacterSettingsView;
  save: SaveSettings;
  pending: boolean;
}) {
  const [mode, setMode] = useState<"always" | "on_request" | undefined>(undefined);
  const [searchModel, setSearchModel] = useState<number | null | undefined>(undefined);
  const [sources, setSources] = useState<CuratedSourceRow[] | undefined>(undefined);
  const modeValue = mode ?? settings.luciusBestPractice;
  const modelValue = searchModel !== undefined ? searchModel : settings.luciusSearchAiModelId;
  const sourcesValue = sources ?? settings.luciusSources;
  const sourcesError = sources ? validateCuratedSources(sources) : null;
  const dirty =
    modeValue !== settings.luciusBestPractice ||
    modelValue !== settings.luciusSearchAiModelId ||
    (sources !== undefined && JSON.stringify(sources) !== JSON.stringify(settings.luciusSources));

  const setRow = (i: number, patch: Partial<CuratedSourceRow>) =>
    setSources(sourcesValue.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-label">Best practice</h3>
        <p className="text-sm text-muted-foreground">
          Prima di proporre, Lucius cerca le best practice per app simili. Ricerca Google tramite Gemini: 5 000 ricerche
          gratuite al mese con i modelli Gemini 3, poi circa 0,014 $ l'una.
        </p>
      </div>
      <div className="grid max-w-md gap-2">
        <Label htmlFor="lucius-bp-mode">Best practice</Label>
        <Select value={modeValue} onValueChange={(v) => setMode(v as "always" | "on_request")} disabled={pending}>
          <SelectTrigger id="lucius-bp-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Sempre</SelectItem>
            <SelectItem value="on_request">Su richiesta</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid max-w-md gap-2">
        <Label htmlFor="lucius-bp-model">Modello per la ricerca</Label>
        <Select
          value={modelValue === null ? NO_MODEL : String(modelValue)}
          onValueChange={(v) => setSearchModel(v === NO_MODEL ? null : Number(v))}
          disabled={pending}
        >
          <SelectTrigger id="lucius-bp-model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_MODEL}>Nessuno</SelectItem>
            {settings.searchModels.map((m) => (
              <SelectItem key={m.id} value={String(m.id)}>
                {m.name} · {m.accountName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {settings.searchModels.length === 0 && (
          <p className="text-sm text-muted-foreground">Aggiungi un account Gemini per cercare le best practice.</p>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-label">Fonti curate</p>
        <p className="text-sm text-muted-foreground">
          Pagine https che Lucius può leggere insieme alla ricerca (al più {MAX_CURATED_SOURCES}).
        </p>
        {sourcesValue.map((row, i) => (
          <div key={i} className="flex min-w-0 flex-wrap items-center gap-2">
            <Input
              aria-label={`Etichetta della fonte ${i + 1}`}
              placeholder="Etichetta"
              className="w-full max-w-[12rem]"
              value={row.label}
              disabled={pending}
              onChange={(e) => setRow(i, { label: e.target.value })}
            />
            <Input
              aria-label={`Indirizzo della fonte ${i + 1}`}
              placeholder="https://…"
              className="min-w-0 flex-1 basis-48"
              value={row.url}
              disabled={pending}
              onChange={(e) => setRow(i, { url: e.target.value })}
            />
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setSources(sourcesValue.filter((_, j) => j !== i))}>
              Togli
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={pending || sourcesValue.length >= MAX_CURATED_SOURCES}
          onClick={() => setSources([...sourcesValue, { label: "", url: "" }])}
        >
          Aggiungi
        </Button>
        {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
      </div>
      <Button
        disabled={!dirty || pending || sourcesError !== null}
        onClick={() =>
          save(
            {
              luciusBestPractice: modeValue,
              luciusSearchAiModelId: modelValue,
              luciusSources: sourcesValue.map((r) => ({ label: r.label.trim(), url: r.url.trim() })),
            },
            "Lucius",
            () => {
              setMode(undefined);
              setSearchModel(undefined);
              setSources(undefined);
            },
          )
        }
      >
        {pending ? "Salvataggio…" : "Salva le best practice"}
      </Button>
    </div>
  );
}

/** Account → Personaggi: Alfred (voce, modello scritto, tetto) e Lucius (modello, tetto). */
export function CharactersSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const settings = useGetCharacterSettings({ query: { queryKey: getGetCharacterSettingsQueryKey() } });
  // Un solo PUT per i due personaggi: mentre è in corso entrambi i blocchi sono disattivati, e il successivo parte
  // dalla cache aggiornata con la risposta del precedente (altrimenti si riscriverebbero valori vecchi).
  const update = useUpdateCharacterSettings({
    mutation: {
      onSuccess: (result) => queryClient.setQueryData(getGetCharacterSettingsQueryKey(), result),
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const save: SaveSettings = (patch, name, onSaved) => {
    const latest = queryClient.getQueryData<CharacterSettingsView>(getGetCharacterSettingsQueryKey()) ?? settings.data;
    if (!latest || update.isPending) return;
    // Il PUT sostituisce tutti e quattro i campi: gli altri restano quelli salvati
    update.mutate(
      {
        data: {
          alfredChatAiModelId: latest.alfredChatAiModelId,
          luciusAiModelId: latest.luciusAiModelId,
          alfredMonthlyBudgetUsd: latest.alfredMonthlyBudgetUsd,
          luciusMonthlyBudgetUsd: latest.luciusMonthlyBudgetUsd,
          ...patch,
        },
      },
      {
        onSuccess: () => {
          onSaved?.();
          toast({ title: `Impostazioni di ${name} salvate` });
        },
      },
    );
  };

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
            <WrittenBlock character="alfred" settings={settings.data} save={save} pending={update.isPending} />
          )}
          <PersonalInstructionsBlock character="alfred" />
        </section>
        {settings.data && (
          <section className="space-y-6" aria-labelledby="characters-lucius">
            <h2 id="characters-lucius" className="text-h2">
              Lucius
            </h2>
            <WrittenBlock character="lucius" settings={settings.data} save={save} pending={update.isPending} />
            <BestPracticeBlock settings={settings.data} save={save} pending={update.isPending} />
            <PersonalInstructionsBlock character="lucius" />
          </section>
        )}
        <section className="space-y-6" aria-labelledby="characters-barbara">
          <h2 id="characters-barbara" className="text-h2">
            Barbara
          </h2>
          <BarbaraInstructionsBlock />
        </section>
      </CardContent>
    </Card>
  );
}
