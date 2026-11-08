import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListAgentTriggersQueryKey, useSetTriggerSigningSecret, type Trigger } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";

/** Indirizzo del webhook, mostrato una sola volta (dopo la creazione o la rigenerazione). */
export function WebhookUrlDialog({ url, onClose }: { url: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [url]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona l'indirizzo e copialo a mano." });
    }
  };

  return (
    <Dialog open={url !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Indirizzo del webhook</DialogTitle>
          <DialogDescription>
            L'indirizzo contiene il segreto e si vede una sola volta: copialo ora. Se lo perdi, rigeneralo dall'elenco degli inneschi.
          </DialogDescription>
        </DialogHeader>
        <Input readOnly value={url ?? ""} className="font-mono text-xs" onFocus={(event) => event.target.select()} aria-label="Indirizzo del webhook" />
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Chiudi
          </Button>
          <Button onClick={() => void copy()}>{copied ? "Copiato" : "Copia indirizzo"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Segreto di firma del webhook (16..200 caratteri); il valore non si rilegge mai. */
export function SigningSecretDialog({ trigger, onClose }: { trigger: Trigger | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [secret, setSecret] = useState("");
  useEffect(() => setSecret(""), [trigger?.id]);

  const save = useSetTriggerSigningSecret({
    mutation: {
      onSuccess: (saved) => {
        void queryClient.invalidateQueries({ queryKey: getListAgentTriggersQueryKey(saved.agentId) });
        toast({ title: "Segreto di firma impostato" });
        onClose();
      },
      onError: (error) => toast({ variant: "destructive", title: "Salvataggio non riuscito", description: apiErrorMessage(error) }),
    },
  });
  const valid = secret.length >= 16 && secret.length <= 200;

  return (
    <Dialog open={trigger !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Segreto di firma</DialogTitle>
          <DialogDescription>
            Le chiamate al webhook dovranno portare nell'intestazione X-Hub-Signature-256 la firma HMAC-SHA256 del corpo, calcolata con questo segreto. Da 16 a 200 caratteri.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="signing-secret">Segreto</Label>
          <Input id="signing-secret" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </div>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" onClick={onClose}>
            Annulla
          </Button>
          <Button
            disabled={!valid || save.isPending}
            onClick={() => trigger && save.mutate({ id: trigger.id, data: { secret } })}
          >
            {save.isPending ? "Salvataggio…" : "Imposta segreto"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
