import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { type App, SourceType, getGetAppQueryKey, getListAppsQueryKey, useUpdateApp } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

const MAX_DESCRIPTION = 20_000;

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
    const tokenChange = token && isGithub ? { sourceToken: token } : clearToken ? { sourceToken: null } : {};
    updateApp.mutate({
      id: app.id,
      data: {
        sourceType,
        // Repo e branch servono solo con GitHub: con gli altri tipi si azzerano, così un valore nascosto
        // e non valido non fa fallire il salvataggio.
        sourceRepo: isGithub ? repo.trim() || null : null,
        sourceBranch: isGithub ? branch.trim() || null : null,
        openapiUrl: openapiUrl.trim() || null,
        functionalDescription: description.trim() || null,
        ...tokenChange,
      },
    });
  };

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
        {sourceType === "github" && (
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
