import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type App,
  ApiError,
  type GithubRepo,
  SourceType,
  getGetAppQueryKey,
  getGetCurrentUserQueryKey,
  getListAppsQueryKey,
  getListGithubReposQueryKey,
  useGetCurrentUser,
  useListGithubRepos,
  useUpdateApp,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const MAX_DESCRIPTION = 20_000;

/** Repository GitHub: dall'installazione dell'App Casello o con un token manuale (fase 3). */
type GithubMode = "installation" | "manual";

/** Valore della combo: installazione e repo insieme (lo stesso repo può arrivare da più installazioni). */
function repoValue(installationId: number, fullName: string): string {
  return `${installationId}:${fullName}`;
}

function parseRepoValue(value: string): { installationId: number; fullName: string } | null {
  const sep = value.indexOf(":");
  const installationId = Number(value.slice(0, sep));
  const fullName = value.slice(sep + 1);
  return sep > 0 && Number.isSafeInteger(installationId) && fullName ? { installationId, fullName } : null;
}

/** Sorgenti che l'architetto analizza: codice (GitHub o zip), OpenAPI e descrizione funzionale. */
export function AppSourcesCard({ app }: { app: App }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceType, setSourceType] = useState<SourceType>(app.sourceType);
  const [repo, setRepo] = useState(app.sourceRepo ?? "");
  const [branch, setBranch] = useState(app.sourceBranch ?? "");
  const [openapiUrl, setOpenapiUrl] = useState(app.openapiUrl ?? "");
  const [description, setDescription] = useState(app.functionalDescription ?? "");
  // Il token non torna mai dall'API: resta invariato salvo nuovo valore o rimozione esplicita.
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const tokenSet = app.sourceTokenSet && !clearToken;

  // Combo dei repository solo con GitHub configurato e collegato dall'utente
  const me = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const githubEnabled = me.data?.githubEnabled ?? false;
  const githubLinked = me.data?.identities.some((identity) => identity.provider === "github") ?? false;
  const canUseInstallations = githubEnabled && githubLinked;
  // Con un'installazione salvata si apre la combo; con un repo e il token manuale, i campi manuali
  const [mode, setMode] = useState<GithubMode>(() =>
    app.sourceInstallationId !== null ? "installation" : app.sourceRepo ? "manual" : "installation",
  );
  const githubMode: GithubMode = canUseInstallations ? mode : "manual";
  const [selectedRepo, setSelectedRepo] = useState(
    app.sourceInstallationId !== null && app.sourceRepo ? repoValue(app.sourceInstallationId, app.sourceRepo) : "",
  );
  const repos = useListGithubRepos({
    query: {
      queryKey: getListGithubReposQueryKey(),
      enabled: sourceType === "github" && githubMode === "installation",
    },
  });

  const updateApp = useUpdateApp({
    mutation: {
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: getGetAppQueryKey(saved.id) });
        void queryClient.invalidateQueries({ queryKey: getListAppsQueryKey() });
        setToken("");
        setClearToken(false);
        toast({ title: "Sorgenti salvate" });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });

  const save = () => {
    const isGithub = sourceType === "github";
    const common = {
      sourceType,
      // Branch solo con GitHub: con gli altri tipi si azzera, così un valore nascosto e non valido
      // non fa fallire il salvataggio (lo stesso per il repo, qui sotto).
      sourceBranch: isGithub ? branch.trim() || null : null,
      openapiUrl: openapiUrl.trim() || null,
      functionalDescription: description.trim() || null,
    };
    if (isGithub && githubMode === "installation") {
      // Con l'installazione il token manuale non serve: non si invia (resta salvato ma inutilizzato)
      const picked = parseRepoValue(selectedRepo);
      updateApp.mutate({
        id: app.id,
        data: {
          ...common,
          sourceRepo: picked?.fullName ?? null,
          sourceInstallationId: picked?.installationId ?? null,
        },
      });
      return;
    }
    const tokenChange = token && isGithub ? { sourceToken: token } : clearToken ? { sourceToken: null } : {};
    const sourceRepo = isGithub ? repo.trim() || null : null;
    // Si passa al token manuale (installazione a null) se l'utente l'ha scelto, o se cambia repo o
    // token. Chi non ha GitHub collegato e non tocca il repo lascia com'è l'installazione salvata da
    // un altro utente. Con gli altri tipi l'API azzera da sé l'installazione.
    const dropInstallation =
      isGithub && (canUseInstallations || sourceRepo !== app.sourceRepo || Boolean(token) || clearToken);
    updateApp.mutate({
      id: app.id,
      data: {
        ...common,
        sourceRepo,
        ...(dropInstallation ? { sourceInstallationId: null } : {}),
        ...tokenChange,
      },
    });
  };

  const pickedRepo = parseRepoValue(selectedRepo);
  const repoList: GithubRepo[] = repos.data ?? [];
  const pickedInfo = pickedRepo
    ? repoList.find((r) => r.installationId === pickedRepo.installationId && r.fullName === pickedRepo.fullName)
    : undefined;
  const branchPlaceholder = pickedInfo
    ? `Facoltativo (default: ${pickedInfo.defaultBranch})`
    : "Facoltativo (default del repo)";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sorgenti</CardTitle>
        <CardDescription>Ciò che l'architetto legge per proporre tool, agenti e skill. Non scrive mai sul codice.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="source-type">Codice sorgente</Label>
            <Select value={sourceType} onValueChange={(v) => setSourceType(v as SourceType)}>
              <SelectTrigger id="source-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="github">GitHub</SelectItem>
                <SelectItem value="zip">Archivio zip</SelectItem>
                <SelectItem value="none">Nessuno</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="source-openapi">URL OpenAPI</Label>
            <Input
              id="source-openapi"
              inputMode="url"
              placeholder="Facoltativo, es. https://mister.example.com/openapi.json"
              value={openapiUrl}
              onChange={(e) => setOpenapiUrl(e.target.value)}
            />
          </div>
        </div>
        {sourceType === "github" && githubMode === "installation" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="source-repo-pick">Repository</Label>
              {repos.isLoading ? (
                <p className="text-sm text-muted-foreground">Caricamento dei repository…</p>
              ) : repos.isError ? (
                <p className="text-sm text-destructive">
                  {repos.error instanceof ApiError && repos.error.status === 404
                    ? "GitHub non configurato"
                    : apiErrorMessage(repos.error)}
                </p>
              ) : repoList.length === 0 && !pickedRepo ? (
                <p className="text-sm text-muted-foreground">
                  Nessun repository: installa l'App Casello dalla{" "}
                  <Link href="/account" className="underline">
                    pagina Account
                  </Link>
                </p>
              ) : (
                <Select value={selectedRepo} onValueChange={setSelectedRepo}>
                  <SelectTrigger id="source-repo-pick" className="font-mono">
                    <SelectValue placeholder="Scegli un repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Il repo salvato resta visibile anche se l'installazione non lo vede più */}
                    {pickedRepo && !pickedInfo && (
                      <SelectItem value={selectedRepo} className="font-mono">
                        {pickedRepo.fullName} (non più disponibile)
                      </SelectItem>
                    )}
                    {repoList.map((r) => (
                      <SelectItem
                        key={repoValue(r.installationId, r.fullName)}
                        value={repoValue(r.installationId, r.fullName)}
                        className="font-mono"
                      >
                        <span className="flex items-center gap-2">
                          {r.fullName}
                          {r.private && (
                            <Badge variant="outline" className="font-sans text-xs">
                              privato
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-branch">Branch</Label>
              <Input
                id="source-branch"
                className="font-mono"
                placeholder={branchPlaceholder}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
              {app.sourceTokenSet && (
                <p>Il token manuale salvato non viene usato finché è scelta un'installazione.</p>
              )}
              <p>
                <button type="button" className="underline" onClick={() => setMode("manual")}>
                  usa un token manuale
                </button>
              </p>
            </div>
          </div>
        )}
        {sourceType === "github" && githubMode === "manual" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="source-repo">Repository</Label>
              <Input
                id="source-repo"
                className="font-mono"
                placeholder="owner/nome"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="source-branch">Branch</Label>
              <Input
                id="source-branch"
                className="font-mono"
                placeholder="Facoltativo (default del repo)"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="source-token">Token GitHub (sola lettura)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="source-token"
                  type="password"
                  autoComplete="new-password"
                  placeholder={tokenSet ? "Impostato (lascia vuoto per non cambiarlo)" : "Non impostato"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                {tokenSet && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setClearToken(true)}>
                    Rimuovi
                  </Button>
                )}
              </div>
              {clearToken && app.sourceTokenSet && !token && (
                <p className="text-xs text-muted-foreground">
                  Il token verrà cancellato al salvataggio.{" "}
                  <button type="button" className="underline" onClick={() => setClearToken(false)}>
                    Annulla rimozione
                  </button>
                </p>
              )}
            </div>
            <div className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
              {!canUseInstallations && app.sourceInstallationId !== null && (
                <p>
                  Il repository è letto tramite un'installazione di GitHub che non hai collegato: cambiando repository o
                  token si passa al token manuale.
                </p>
              )}
              {canUseInstallations ? (
                <button type="button" className="underline" onClick={() => setMode("installation")}>
                  scegli tra i repository collegati
                </button>
              ) : (
                githubEnabled && (
                  <p>
                    <Link href="/account" className="underline">
                      Collega GitHub
                    </Link>{" "}
                    dalla pagina Account per scegliere il repository da un elenco.
                  </p>
                )
              )}
            </div>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="source-description">Descrizione funzionale</Label>
          <Textarea
            id="source-description"
            rows={10}
            maxLength={MAX_DESCRIPTION}
            placeholder="Facoltativa: cosa fa l'app, per chi, i flussi principali."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="text-right text-xs text-muted-foreground">
            {description.length} / {MAX_DESCRIPTION}
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={updateApp.isPending}>
            {updateApp.isPending ? "Salvataggio…" : "Salva sorgenti"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
