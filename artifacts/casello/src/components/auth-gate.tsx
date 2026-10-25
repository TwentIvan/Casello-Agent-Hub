import type { ReactNode } from "react";
import { getGetCurrentUserQueryKey, useGetCurrentUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { isUnauthorized } from "@/lib/auth";
import Login from "@/pages/login";

/** Mostra l'app solo con una sessione valida, altrimenti la pagina di login. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey(), retry: false, staleTime: 5 * 60_000 },
  });

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  if (me.isError && isUnauthorized(me.error)) {
    return <Login />;
  }
  if (me.isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-muted-foreground">Impossibile contattare l'API di Casello.</p>
        <Button variant="outline" size="sm" onClick={() => me.refetch()}>
          Riprova
        </Button>
      </div>
    );
  }
  return <>{children}</>;
}
