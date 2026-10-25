import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { loginUrl } from "@/lib/auth";

const MESSAGES: Record<string, string> = {
  denied: "Questo account Google non è autorizzato ad accedere a Casello.",
  error: "Accesso non riuscito. Riprova.",
};

export default function Login() {
  const reason = new URLSearchParams(window.location.search).get("auth");
  const message = reason ? MESSAGES[reason] : undefined;

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
          <Button asChild className="w-full">
            <a href={loginUrl()}>Accedi con Google</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
