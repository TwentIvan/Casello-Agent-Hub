import { AlertCircle } from "lucide-react";
import { getGetAuthProvidersQueryKey, useGetAuthProviders } from "@workspace/api-client-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { githubLoginUrl, loginUrl } from "@/lib/auth";

const MESSAGES: Record<string, string> = {
  denied: "Questo account Google non è autorizzato ad accedere a Casello.",
  error: "Accesso non riuscito. Riprova.",
};

function loginMessage(params: URLSearchParams): string | undefined {
  const reason = params.get("auth");
  if (reason === "denied" && params.get("provider") === "github") return "email GitHub non autorizzata";
  if (reason) return MESSAGES[reason];
  if (params.get("github") === "cancelled") return "Accesso con GitHub annullato.";
  return undefined;
}

export default function Login() {
  const message = loginMessage(new URLSearchParams(window.location.search));
  // Pubblica: dice se mostrare anche l'accesso con GitHub (in caso di errore resta solo Google)
  const providers = useGetAuthProviders({
    query: { queryKey: getGetAuthProvidersQueryKey(), retry: false, staleTime: 5 * 60_000 },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col items-center gap-5 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
            C
          </span>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Casello</h1>
            <p className="text-sm text-muted-foreground">Accedi per gestire app, agenti ed esecuzioni.</p>
          </div>
          {message && (
            <Alert variant="destructive" className="text-left">
              <AlertCircle className="size-4" />
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          <div className="flex w-full flex-col gap-2">
            <Button asChild className="w-full">
              <a href={loginUrl()}>Accedi con Google</a>
            </Button>
            {providers.data?.github && (
              <Button asChild variant="outline" className="w-full">
                <a href={githubLoginUrl()}>Accedi con GitHub</a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
