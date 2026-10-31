import { type ReactNode, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type CurrentUser,
  getGetCurrentUserQueryKey,
  getListGithubInstallationsQueryKey,
  getListGithubReposQueryKey,
  useGetCurrentUser,
  useListGithubInstallations,
  useUnlinkGithub,
} from "@workspace/api-client-react";
import { AiAccountsSection } from "@/components/account/ai-accounts-section";
import { DefaultModelCard } from "@/components/account/default-model-card";
import { ApiTokensSection } from "@/components/account/api-tokens-section";
import { UserBudgetCard } from "@/components/budget/budget";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { GITHUB_LINK_URL } from "@/lib/auth";

const GITHUB_NOT_CONFIGURED = "GitHub non configurato";

/** Esiti del collegamento con GitHub che tornano in `?github=`. */
const GITHUB_RESULTS: Record<string, { title: string; destructive: boolean }> = {
  conflict: { title: "account GitHub già collegato a un altro utente", destructive: true },
  error: { title: "Collegamento con GitHub non riuscito. Riprova.", destructive: true },
  cancelled: { title: "Collegamento con GitHub annullato.", destructive: false },
};

/** Legge `?github=` una sola volta, mostra l'esito e toglie il parametro dall'URL. */
function useGithubResultToast() {
  const { toast } = useToast();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const url = new URL(window.location.href);
    const result = url.searchParams.get("github");
    if (result === null) return;
    const known = GITHUB_RESULTS[result];
    if (known) toast({ variant: known.destructive ? "destructive" : "default", title: known.title });
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [toast]);
}

function IdentityRow({ label, detail, action }: { label: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-sm text-muted-foreground">{detail}</div>
      </div>
      {action}
    </div>
  );
}

function AccessCard({ user }: { user: CurrentUser }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const google = user.identities.find((identity) => identity.provider === "google");
  const github = user.identities.find((identity) => identity.provider === "github");

  const unlink = useUnlinkGithub({
    mutation: {
      onSuccess: () => {
        setConfirmUnlink(false);
        void queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListGithubInstallationsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListGithubReposQueryKey() });
        toast({ title: "GitHub scollegato" });
      },
      onError: (error) => {
        setConfirmUnlink(false);
        toast({ variant: "destructive", title: "Impossibile scollegare GitHub", description: apiErrorMessage(error) });
      },
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accessi</CardTitle>
        <CardDescription>Gli account con cui entri in Casello.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {google && <IdentityRow label="Google" detail={google.email ?? user.email} />}
        {github ? (
          <IdentityRow
            label="GitHub"
            detail={github.username ? `@${github.username}` : (github.email ?? "Collegato")}
            action={
              <Button variant="outline" size="sm" onClick={() => setConfirmUnlink(true)}>
                Scollega GitHub
              </Button>
            }
          />
        ) : user.githubEnabled ? (
          <IdentityRow
            label="GitHub"
            detail="Non collegato"
            action={
              <Button asChild size="sm">
                <a href={GITHUB_LINK_URL}>Collega GitHub</a>
              </Button>
            }
          />
        ) : (
          <IdentityRow label="GitHub" detail={GITHUB_NOT_CONFIGURED} />
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Scollegare GitHub?"
        description="Verranno rimosse anche le installazioni dell'App Casello collegate al tuo account. Le app che usano un'installazione non potranno più scaricare il repository finché non la ricolleghi o non imposti un token manuale."
        confirmLabel="Scollega"
        pendingLabel="Scollegamento…"
        pending={unlink.isPending}
        onConfirm={() => unlink.mutate()}
      />
    </Card>
  );
}

function InstallationsCard({ githubEnabled }: { githubEnabled: boolean }) {
  const installations = useListGithubInstallations({
    query: { queryKey: getListGithubInstallationsQueryKey(), enabled: githubEnabled },
  });
  const notConfigured =
    !githubEnabled || (installations.error instanceof ApiError && installations.error.status === 404);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Installazioni di GitHub</CardTitle>
        <CardDescription>Account e organizzazioni in cui è installata l'App Casello: da qui l'architetto legge i repository.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {notConfigured ? (
          <p className="text-sm text-muted-foreground">{GITHUB_NOT_CONFIGURED}</p>
        ) : installations.isError ? (
          <p className="text-sm text-destructive">
            Impossibile caricare le installazioni: {apiErrorMessage(installations.error)}
          </p>
        ) : !installations.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            {installations.data.installations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nessuna installazione: installa l'App Casello sul tuo account o su un'organizzazione per scegliere i
                repository.
              </p>
            ) : (
              installations.data.installations.map((installation) => (
                <div
                  key={installation.installationId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium">{installation.accountLogin}</span>
                      <Badge variant="outline">
                        {installation.accountType === "Organization" ? "Organizzazione" : "Utente"}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {installation.repositorySelection === "all" ? "Tutti i repository" : "Repository selezionati"}
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <a href={installation.manageUrl} target="_blank" rel="noopener noreferrer">
                      Gestisci su GitHub
                      <ExternalLink />
                    </a>
                  </Button>
                </div>
              ))
            )}
            <div className="flex justify-end">
              {/* Stessa scheda: GitHub torna al callback, che riporta alla pagina Account */}
              <Button asChild size="sm">
                <a href={installations.data.installUrl}>Installa Casello su GitHub</a>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AccountPage() {
  useGithubResultToast();
  const me = useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey() } });
  const githubLinked = me.data?.identities.some((identity) => identity.provider === "github") ?? false;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Account</h2>
        <p className="text-sm text-muted-foreground">Accessi collegati, account AI e installazioni dell'App Casello su GitHub.</p>
      </div>
      {!me.data ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
          <AccessCard user={me.data} />
          <AiAccountsSection />
          <DefaultModelCard />
          <UserBudgetCard />
          <ApiTokensSection />
          {githubLinked && <InstallationsCard githubEnabled={me.data.githubEnabled} />}
        </>
      )}
    </div>
  );
}
