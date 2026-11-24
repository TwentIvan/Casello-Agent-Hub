import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAppBootstrapConfigQueryKey,
  getGetCharacterSettingsQueryKey,
  getGetDashboardStatsQueryKey,
  getListAnalysesQueryKey,
  getListAppsQueryKey,
  getListGithubReposQueryKey,
  useCreateApp,
  useGetAppBootstrapConfig,
  useGetCharacterSettings,
  useListApps,
  useListGithubRepos,
  useStartAnalysis,
} from "@workspace/api-client-react";
import { useDefaultAiModelId } from "@/components/ai/ai-queries";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { DEFAULT_BASE_DOMAIN } from "@/lib/app-bootstrap";
import { appNameFromRepo, repoKey, slugPreview, suggestedBaseUrl, unregisteredRepos } from "@/lib/app-from-github";

/**
 * Modulo «Da GitHub» della nuova app (onboarding guidato, issue #111): dal repository scelto propone nome, slug, base URL e
 * branch, crea l'App con il codice collegato tramite l'App GitHub e, se richiesto, mette subito in coda l'analisi per l'agente locale.
 */
export function AppFromGithubForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const config = useGetAppBootstrapConfig({ query: { queryKey: getGetAppBootstrapConfigQueryKey() } });
  const baseDomain = config.data?.baseDomain ?? DEFAULT_BASE_DOMAIN;
  const repos = useListGithubRepos({ query: { queryKey: getListGithubReposQueryKey() } });
  const apps = useListApps({ query: { queryKey: getListAppsQueryKey() } });
  const characterSettings = useGetCharacterSettings({ query: { queryKey: getGetCharacterSettingsQueryKey() } });
  const defaultModelId = useDefaultAiModelId();

  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [model, setModel] = useState<number | null | undefined>(undefined);
  const [analyze, setAnalyze] = useState(true);
  const [busy, setBusy] = useState(false);
  const aiModelId = model !== undefined ? model : defaultModelId;

  const candidates = unregisteredRepos(repos.data ?? [], apps.data ?? []);
  const chosen = candidates.find((r) => repoKey(r) === key) ?? null;
  const loaded = (repos.data !== undefined || repos.isError) && (apps.data !== undefined || apps.isError);

  // Scegliendo un repository si ripropongono nome, base URL e branch (si correggono dopo)
  const chooseRepo = (next: string) => {
    setKey(next);
    const repo = candidates.find((r) => repoKey(r) === next);
    if (!repo) return;
    const proposed = appNameFromRepo(repo.fullName);
    setName(proposed);
    setBaseUrl(suggestedBaseUrl(proposed, baseDomain));
    setBranch(repo.defaultBranch);
  };

  const createApp = useCreateApp();
  const startAnalysis = useStartAnalysis();

  const baseUrlValid = URL.canParse(baseUrl.trim());
  const ready = chosen !== null && name.trim() !== "" && baseUrlValid && !busy;

  const submit = async () => {
    if (!chosen) return;
    setBusy(true);
    let created;
    try {
      created = await createApp.mutateAsync({
        data: {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          status: "active",
          sourceType: "github",
          sourceRepo: chosen.fullName,
          sourceBranch: branch.trim() || null,
          sourceInstallationId: chosen.installationId,
          ...(aiModelId !== null ? { generalAgentAiModelId: aiModelId } : {}),
        },
      });
    } catch (error) {
      toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) });
      setBusy(false);
      return;
    }
    void queryClient.invalidateQueries({ queryKey: getListAppsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
    if (analyze) {
      try {
        await startAnalysis.mutateAsync({
          id: created.id,
          data: { executor: "local", bestPractice: characterSettings.data?.luciusBestPractice === "always" },
        });
        void queryClient.invalidateQueries({ queryKey: getListAnalysesQueryKey(created.id) });
        toast({
          title: `App ${created.name} creata`,
          description: "Analisi in coda per l'agente locale: avviala con la skill casello-architetto-locale.",
        });
      } catch (error) {
        // L'app resta: l'analisi si riavvia dalla sua scheda
        toast({
          variant: "destructive",
          title: `App ${created.name} creata, analisi non avviata`,
          description: apiErrorMessage(error),
        });
      }
    } else {
      toast({ title: `App ${created.name} creata` });
    }
    setBusy(false);
    onDone();
    navigate(`/apps/${created.id}`);
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="gh-repo">Repository</Label>
        {candidates.length > 0 ? (
          <Select value={key} onValueChange={chooseRepo}>
            <SelectTrigger id="gh-repo">
              <SelectValue placeholder="Scegli il repository" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((r) => (
                <SelectItem key={repoKey(r)} value={repoKey(r)}>
                  {r.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="text-muted-foreground">
              {!loaded
                ? "Leggo i repository dell'App GitHub…"
                : repos.isError
                  ? `Repository non disponibili: ${apiErrorMessage(repos.error)}`
                  : "Nessun repository da collegare: quelli raggiungibili dall'App GitHub sono già tutti App di Botcave."}
            </p>
            {loaded && (
              <Button asChild variant="outline" size="sm">
                <a href="/api/auth/github/link">Ricollega GitHub</a>
              </Button>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">Solo i repository dell'App GitHub non ancora collegati a un'App.</p>
      </div>
      {chosen && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="gh-name">Nome</Label>
            <Input id="gh-name" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Slug: <span className="font-mono">{slugPreview(name)}</span> (se è già usato Botcave aggiunge l'id).
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="gh-base-url">Base URL</Label>
              <Input id="gh-base-url" className="font-mono" inputMode="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              {!baseUrlValid && baseUrl.trim() !== "" && (
                <p className="text-xs text-danger">Inserisci un URL completo, es. https://mister.example.com.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gh-branch">Branch</Label>
              <Input id="gh-branch" className="font-mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gh-model">Modello del Responsabile di prodotto</Label>
            <ModelPicker id="gh-model" value={aiModelId} onChange={setModel} />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <Label htmlFor="gh-analyze">Analizza subito con l'agente locale</Label>
              <p className="text-xs text-muted-foreground">
                L'analisi va in coda per Claude Code sul tuo Mac (skill casello-architetto-locale), senza costi su Botcave.
                Le proposte di Lucius si approvano poi nella scheda dell'app.
              </p>
            </div>
            <Switch id="gh-analyze" checked={analyze} onCheckedChange={setAnalyze} />
          </div>
          <p className="text-xs text-muted-foreground">
            Autenticazione, indirizzo interno e header si impostano dopo con «Modifica» nella scheda dell'app.
          </p>
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Annulla
        </Button>
        <Button type="submit" disabled={!ready}>
          {busy ? "Creazione…" : analyze ? "Crea e analizza" : "Crea app"}
        </Button>
      </DialogFooter>
    </form>
  );
}
