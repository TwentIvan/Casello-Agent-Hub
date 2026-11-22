import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAppBootstrapConfigQueryKey,
  getGetDashboardStatsQueryKey,
  getListGithubReposQueryKey,
  useCreateAppBootstrap,
  useGetAppBootstrapConfig,
  useGetDefaultModel,
  getGetDefaultModelQueryKey,
  useListGithubRepos,
} from "@workspace/api-client-react";
import { ModelPicker } from "@/components/ai/model-picker";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  DEFAULT_BASE_DOMAIN,
  domainFollowsSlug,
  repoMatchesSlug,
  slugFromName,
  suggestedDomain,
  templateGenerateUrl,
} from "@/lib/app-bootstrap";

const BRIEF_MAX = 20_000;

/** Modulo «Da zero» della nuova app: nome, indirizzo, repository del modello e descrizione. Non scrive nulla: crea una voce in «Da confermare». */
export function AppBootstrapForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const config = useGetAppBootstrapConfig({ query: { queryKey: getGetAppBootstrapConfigQueryKey() } });
  const baseDomain = config.data?.baseDomain ?? DEFAULT_BASE_DOMAIN;
  const repos = useListGithubRepos({ query: { queryKey: getListGithubReposQueryKey() } });
  const defaultModel = useGetDefaultModel({ query: { queryKey: getGetDefaultModelQueryKey() } });

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [domain, setDomain] = useState("");
  const [brief, setBrief] = useState("");
  const [repoKey, setRepoKey] = useState("");
  const [model, setModel] = useState<number | null | undefined>(undefined);
  const aiModelId = model !== undefined ? model : (defaultModel.data?.aiModelId ?? null);

  const changeSlug = (next: string) => {
    if (domainFollowsSlug(domain, slug, baseDomain)) setDomain(next ? suggestedDomain(next, baseDomain) : "");
    setSlug(next);
  };
  const changeName = (next: string) => {
    setName(next);
    if (!slugTouched) changeSlug(slugFromName(next));
  };

  const candidates = (repos.data ?? []).filter((r) => repoMatchesSlug(r.fullName, slug));
  const chosen = candidates.find((r) => `${r.installationId}:${r.fullName}` === repoKey) ?? null;
  const reposLoaded = repos.data !== undefined || repos.isError;

  const create = useCreateAppBootstrap({
    mutation: {
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: getGetDashboardStatsQueryKey() });
        toast({ title: `Voce n. ${saved.pendingActionNumber} in Da confermare` });
        onDone();
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Richiesta non riuscita", description: apiErrorMessage(error) }),
    },
  });

  const ready =
    name.trim() !== "" && slug !== "" && domain.trim() !== "" && brief.trim() !== "" && brief.length <= BRIEF_MAX && chosen !== null && aiModelId !== null;

  const submit = () => {
    if (!chosen || aiModelId === null) return;
    create.mutate({
      data: {
        name: name.trim(),
        slug,
        domain: domain.trim(),
        brief,
        repo: chosen.fullName,
        installationId: chosen.installationId,
        aiModelId,
      },
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="boot-name">Nome</Label>
        <Input id="boot-name" value={name} onChange={(e) => changeName(e.target.value)} placeholder="es. Portfolio" autoFocus />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="boot-slug">Slug</Label>
          <Input
            id="boot-slug"
            className="font-mono"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              changeSlug(e.target.value.toLowerCase());
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="boot-domain">Dominio</Label>
          <Input id="boot-domain" className="font-mono" value={domain} onChange={(e) => setDomain(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="boot-brief">Descrizione di cosa deve fare l'app</Label>
        <Textarea id="boot-brief" rows={5} maxLength={BRIEF_MAX} value={brief} onChange={(e) => setBrief(e.target.value)} />
        <p className="text-xs text-muted-foreground">
          Diventa la descrizione funzionale dell'App e il punto di partenza dell'analisi dell'architetto.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="boot-repo">Repository creato dal modello</Label>
        {candidates.length > 0 ? (
          <Select value={repoKey} onValueChange={setRepoKey}>
            <SelectTrigger id="boot-repo">
              <SelectValue placeholder="Scegli il repository" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((r) => (
                <SelectItem key={`${r.installationId}:${r.fullName}`} value={`${r.installationId}:${r.fullName}`}>
                  {r.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="text-muted-foreground">
              {!slug
                ? "Scrivi il nome: il repository deve avere lo stesso nome dello slug."
                : !reposLoaded
                  ? "Leggo i repository dell'App GitHub…"
                  : `Nessun repository chiamato «${slug}» tra quelli raggiungibili dall'App GitHub. Crealo dal modello, poi ricollega GitHub.`}
            </p>
            {reposLoaded && slug && (
              <div className="flex flex-wrap gap-2">
                {config.data && (
                  <Button asChild variant="outline" size="sm">
                    <a href={templateGenerateUrl(config.data.templateRepo)} target="_blank" rel="noopener">
                      Usa il modello su GitHub
                    </a>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm">
                  <a href="/api/auth/github/link">Ricollega GitHub</a>
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="boot-model">Modello del Responsabile e dell'analisi</Label>
        <ModelPicker id="boot-model" cloudOnly value={aiModelId} onChange={setModel} />
      </div>
      <p className="text-xs text-muted-foreground">Nulla viene scritto prima dell'approvazione in Da confermare.</p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Annulla
        </Button>
        <Button type="submit" disabled={!ready || create.isPending}>
          {create.isPending ? "Invio…" : "Chiedi conferma"}
        </Button>
      </DialogFooter>
    </form>
  );
}
