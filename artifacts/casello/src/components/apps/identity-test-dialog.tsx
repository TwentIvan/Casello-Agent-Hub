import { useState } from "react";
import { type IdentityTestResult, useTestIdentity } from "@workspace/api-client-react";
import { Led } from "@/components/brand/led";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api-errors";

const REASONS: Record<string, string> = {
  invalid: "Identità non valida: controlla firma, issuer, audience e scadenza.",
  expired: "Identità scaduta: genera un token nuovo.",
  no_secret: "L'app non ha ancora un segreto d'identità.",
};

/** Verifica un token d'identità con il segreto dell'app, senza creare nulla. */
export function IdentityTestDialog({ appId, open, onOpenChange }: { appId: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<IdentityTestResult | null>(null);
  const test = useTestIdentity({ mutation: { onSuccess: setResult } });

  function close(next: boolean) {
    if (!next) {
      setToken("");
      setResult(null);
      test.reset();
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Prova identità</DialogTitle>
          <DialogDescription>Incolla un token generato dal server della tua app: Botcave lo verifica senza salvarlo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="identity-token">Token</Label>
          <Textarea
            id="identity-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="font-mono text-xs"
            rows={4}
            maxLength={10000}
            spellCheck={false}
          />
        </div>
        {test.isError && <p className="text-sm text-danger">{apiErrorMessage(test.error)}</p>}
        {result && (
          <div className="space-y-1 text-sm">
            <Led state={result.valid ? "ok" : "ko"} label={result.valid ? "Identità valida" : (REASONS[result.reason ?? "invalid"] ?? REASONS.invalid)} />
            {result.valid && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                <dt className="text-ink-muted">Utente</dt>
                <dd className="break-all font-mono">{result.sub}</dd>
                {result.name && (<><dt className="text-ink-muted">Nome</dt><dd className="break-all">{result.name}</dd></>)}
                {result.email && (<><dt className="text-ink-muted">Email</dt><dd className="break-all">{result.email}</dd></>)}
                {result.expiresAt && (<><dt className="text-ink-muted">Scade</dt><dd>{new Date(result.expiresAt).toLocaleString("it-IT")}</dd></>)}
              </dl>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Chiudi
          </Button>
          <Button disabled={!token.trim() || test.isPending} onClick={() => test.mutate({ id: appId, data: { token: token.trim() } })}>
            {test.isPending ? "Verifica…" : "Verifica il token"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
