import { useEffect, useState } from "react";
import { Check, Copy, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Node,
  getListNodesQueryKey,
  useCreateNode,
  useDeleteNode,
  useDisableNode,
  useListNodes,
  useRegenerateNodeToken,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Led } from "@/components/brand/led";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const MAX_NAME = 100;
const MAX_SKILL_CHIPS = 4;
const PRODUCTION_URL = "https://casello.fantamister.cloud";

/** Il token appena creato o rigenerato: vive solo nello stato del componente, mai in storage. */
interface RevealedToken {
  nodeName: string;
  token: string;
  /** Primo token di un nodo nuovo: mostra anche i passi di installazione. */
  isNew: boolean;
}

function NewNodeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (revealed: RevealedToken) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const nameValid = name.trim().length > 0 && name.trim().length <= MAX_NAME;

  const create = useCreateNode({
    mutation: {
      onSuccess: (created) => {
        void queryClient.invalidateQueries({ queryKey: getListNodesQueryKey() });
        setName("");
        onCreated({ nodeName: created.node.name, token: created.token, isNew: true });
      },
      onError: (error) =>
        toast({ variant: "destructive", title: "Creazione non riuscita", description: apiErrorMessage(error) }),
    },
  });

  // Il token in chiaro passa al chiamante e non deve restare nello stato della mutazione
  const created = create.data;
  const resetCreate = create.reset;
  useEffect(() => {
    if (created) resetCreate();
  }, [created, resetCreate]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setName("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (nameValid) create.mutate({ data: { name: name.trim() } });
          }}
        >
          <DialogHeader>
            <DialogTitle>Nuovo nodo</DialogTitle>
            <DialogDescription>
              Un nodo è un Mac su cui gira Claude Code per eseguire i compiti «nodo» delle squadre. Dopo la creazione vedrai
              il suo token una sola volta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="node-name">Nome</Label>
            <Input
              id="node-name"
              value={name}
              maxLength={MAX_NAME}
              placeholder="es. MacBook di Ivan"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => {
                setName("");
                onOpenChange(false);
              }}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={!nameValid || create.isPending}>
              {create.isPending ? "Creazione…" : "Crea nodo"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TokenRevealDialog({ revealed, onClose }: { revealed: RevealedToken | null; onClose: () => void }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const token = revealed?.token ?? null;

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      toast({ variant: "destructive", title: "Copia non riuscita", description: "Seleziona il token e copialo a mano." });
    }
  };
  const close = () => {
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={token !== null} onOpenChange={(open) => !open && close()}>
      {/* Il token si vede una sola volta: si chiude solo con «Fatto», non con Esc o un clic fuori */}
      <DialogContent
        hideClose
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{revealed?.isNew ? "Nodo creato" : "Nuovo token"}</DialogTitle>
          <DialogDescription>
            Token del nodo «{revealed?.nodeName}»: copialo ora, non sarà più visibile.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly aria-label="Token del nodo" value={token ?? ""} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon" aria-label="Copia il token" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {revealed?.isNew ? "Per installare il nodo sul Mac, dalla radice del repository:" : "Per aggiornare il nodo già installato, riesegui l'installazione con il nuovo token:"}
          </p>
          {revealed?.isNew && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">1. Costruisci il programma (richiede Node 24 e Claude Code già con il login fatto).</p>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
                corepack pnpm --filter @workspace/casello-nodo run build
              </pre>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {revealed?.isNew ? "2. " : ""}Installa il servizio: il comando chiede il token (non viene mostrato mentre lo digiti).
            </p>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
              {`node artifacts/casello-nodo/dist/index.mjs install --url ${PRODUCTION_URL} --workspace-root <cartella>`}
            </pre>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              In alternativa salva il token in un file e indicalo con <span className="font-mono">--token-file</span>; evita{" "}
              <span className="font-mono">--token</span>, che resta nella cronologia della shell.
            </p>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
              {`node artifacts/casello-nodo/dist/index.mjs install --url ${PRODUCTION_URL} --workspace-root <cartella> --token-file <file>`}
            </pre>
          </div>
          <p className="text-xs text-muted-foreground">
            La cartella è la radice degli spazi di lavoro: il nodo non esce mai da lì e l'agente vi esegue comandi senza
            chiedere conferma, quindi scegli una cartella che può toccare.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={close}>Fatto</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillChips({ skills }: { skills: string[] }) {
  if (skills.length === 0) return <span className="text-xs text-muted-foreground">nessuna skill dichiarata</span>;
  const shown = skills.slice(0, MAX_SKILL_CHIPS);
  const hidden = skills.slice(MAX_SKILL_CHIPS);
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {shown.map((skill) => (
        <Badge key={skill} variant="outline" className="max-w-[16rem] truncate font-mono text-[11px] font-normal" title={skill}>
          {skill}
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Badge variant="secondary" className="font-normal" title={hidden.join(", ")}>
          +{hidden.length}
        </Badge>
      )}
    </div>
  );
}

function NodeRow({
  node,
  onDisable,
  onRegenerate,
  onDelete,
}: {
  node: Node;
  onDisable: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
}) {
  const disabled = node.status === "disabled";
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{node.name}</span>
          {disabled ? (
            <Led state="idle" label="disattivato" />
          ) : node.online ? (
            <Led state="ok" label="online" />
          ) : (
            <Led state="ko" label="offline" />
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{node.lastSeenAt ? `ultimo contatto ${formatRelative(node.lastSeenAt)}` : "mai collegato"}</span>
          {node.version && <span>versione {node.version}</span>}
          {node.executor && <span>executor {node.executor}</span>}
          <span>{node.maxConcurrent === 1 ? "1 compito alla volta" : `${node.maxConcurrent} compiti alla volta`}</span>
          {node.workspaceRoot && <span className="min-w-0 break-all font-mono">{node.workspaceRoot}</span>}
        </div>
        <SkillChips skills={node.skills} />
      </div>
      <div className="flex flex-wrap gap-2">
        {!disabled && (
          <Button variant="outline" size="sm" onClick={onDisable}>
            Disattiva
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onRegenerate}>
          Rigenera token
        </Button>
        <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
          Elimina
        </Button>
      </div>
    </li>
  );
}

/** Sezione «Nodi» della pagina Account: Mac che eseguono con Claude Code i compiti `node` delle squadre. */
export function NodesSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nodes = useListNodes({ query: { queryKey: getListNodesQueryKey() } });
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [disabling, setDisabling] = useState<Node | null>(null);
  const [regenerating, setRegenerating] = useState<Node | null>(null);
  const [deleting, setDeleting] = useState<Node | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListNodesQueryKey() });

  const disable = useDisableNode({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Nodo disattivato", description: disabling?.name });
        setDisabling(null);
      },
      onError: (error) => {
        setDisabling(null);
        toast({ variant: "destructive", title: "Impossibile disattivare il nodo", description: apiErrorMessage(error) });
      },
    },
  });
  const regenerate = useRegenerateNodeToken({
    mutation: {
      onSuccess: (result) => {
        const node = regenerating;
        refresh();
        setRegenerating(null);
        if (node) setRevealed({ nodeName: node.name, token: result.token, isNew: false });
      },
      onError: (error) => {
        setRegenerating(null);
        toast({ variant: "destructive", title: "Impossibile rigenerare il token", description: apiErrorMessage(error) });
      },
    },
  });
  const remove = useDeleteNode({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Nodo eliminato", description: deleting?.name });
        setDeleting(null);
      },
      onError: (error) => {
        setDeleting(null);
        toast({ variant: "destructive", title: "Impossibile eliminare il nodo", description: apiErrorMessage(error) });
      },
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Nodi</CardTitle>
          <CardDescription>
            Mac su cui gira Claude Code per eseguire i compiti dei ruoli «nodo» delle squadre. Lo stato è «online» se il
            nodo ha comunicato negli ultimi 2 minuti.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus />
          Nuovo nodo
        </Button>
      </CardHeader>
      <CardContent>
        {nodes.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare i nodi: {apiErrorMessage(nodes.error)}</p>
        ) : !nodes.data ? (
          <Skeleton className="h-16 w-full" />
        ) : nodes.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun nodo: creane uno per far eseguire i compiti «nodo» sul tuo Mac.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {nodes.data.map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                onDisable={() => setDisabling(node)}
                onRegenerate={() => setRegenerating(node)}
                onDelete={() => setDeleting(node)}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <NewNodeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(result) => {
          setCreateOpen(false);
          setRevealed(result);
        }}
      />
      <TokenRevealDialog
        revealed={revealed}
        onClose={() => {
          setRevealed(null);
          // Il token in chiaro non deve restare nello stato delle mutazioni
          regenerate.reset();
        }}
      />
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => !open && setDisabling(null)}
        title="Disattivare il nodo?"
        description={`«${disabling?.name ?? ""}» smette di ricevere compiti e dalla console non si può riattivare: per tornare a usare quel Mac crea un nuovo nodo.`}
        confirmLabel="Disattiva"
        pendingLabel="Disattivazione…"
        pending={disable.isPending}
        onConfirm={() => disabling && disable.mutate({ id: disabling.id })}
      />
      <ConfirmDialog
        open={regenerating !== null}
        onOpenChange={(open) => !open && setRegenerating(null)}
        title="Rigenerare il token?"
        description={`Il token attuale di «${regenerating?.name ?? ""}» smette di valere subito: il nodo non potrà più collegarsi finché non lo reinstalli con il nuovo token.`}
        confirmLabel="Rigenera"
        pendingLabel="Rigenerazione…"
        pending={regenerate.isPending}
        onConfirm={() => regenerating && regenerate.mutate({ id: regenerating.id })}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Eliminare il nodo?"
        description={`«${deleting?.name ?? ""}» e i suoi token vengono eliminati: i compiti già eseguiti restano nello storico senza il nome del nodo.`}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
      />
    </Card>
  );
}
