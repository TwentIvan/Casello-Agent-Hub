import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

/**
 * Mostra il segreto d'identità una sola volta. Il segreto vive solo nello stato del chiamante:
 * non entra nella cache delle query né nei log, e chiudendo il dialogo il chiamante lo azzera.
 */
export function IdentitySecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Selezionalo e copialo a mano." });
    }
  }

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Segreto d'identità</DialogTitle>
          <DialogDescription>
            Copialo ora e mettilo nel server della tua app: non verrà mostrato di nuovo. Se lo perdi, rigeneralo.
          </DialogDescription>
        </DialogHeader>
        <code className="block break-all border border-line bg-surface-2 p-3 font-mono text-xs" data-testid="identity-secret">
          {secret}
        </code>
        <DialogFooter>
          <Button variant="secondary" onClick={() => void copy()}>
            <Copy />
            {copied ? "Copiato" : "Copia"}
          </Button>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Ho copiato il segreto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
