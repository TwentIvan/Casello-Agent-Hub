import { useEffect, useMemo, useState } from "react";
import { Folder, FolderOpen, Search } from "lucide-react";
import {
  getGetNodeFoldersQueryKey,
  getListNodesQueryKey,
  useGetNodeFolders,
  useListNodes,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/format";

/** Righe mostrate al massimo: oltre si chiede di affinare la ricerca. */
const MAX_ROWS = 300;
/** Il nodo manda le cartelle a ogni heartbeat (30 s): mentre la finestra è aperta si rileggono con lo stesso passo. */
const REFRESH_MS = 30_000;
/** Limite dell'elenco che il nodo manda (contratto dell'heartbeat). */
const NODE_FOLDERS_MAX = 2000;

interface NodeFolderPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Cartella attuale della squadra: preselezionata se compare nell'elenco. */
  value: string;
  onPick: (folder: string) => void;
}

/**
 * Scelta dello spazio di lavoro tra le cartelle che il nodo comunica con l'heartbeat (sottocartelle della sua radice,
 * fino a 3 livelli). Il browser non vede i percorsi del Mac: l'elenco arriva sempre dal nodo, mai dal computer da cui
 * si apre la console. Si scelgono solo cartelle.
 */
export function NodeFolderPicker({ open, onOpenChange, value, onPick }: NodeFolderPickerProps) {
  const nodes = useListNodes({ query: { queryKey: getListNodesQueryKey(), enabled: open } });
  const activeNodes = useMemo(() => (nodes.data ?? []).filter((n) => n.status === "active"), [nodes.data]);
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // Ad ogni apertura: ricerca vuota, cartella attuale preselezionata, nodo online per primo
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelected(value.trim() === "" ? null : value.trim());
  }, [open, value]);
  useEffect(() => {
    if (!open || activeNodes.length === 0) return;
    if (nodeId !== null && activeNodes.some((n) => n.id === nodeId)) return;
    setNodeId((activeNodes.find((n) => n.online) ?? activeNodes[0]!).id);
  }, [open, activeNodes, nodeId]);

  const folders = useGetNodeFolders(nodeId ?? 0, {
    query: {
      queryKey: getGetNodeFoldersQueryKey(nodeId ?? 0),
      enabled: open && nodeId !== null,
      refetchInterval: open ? REFRESH_MS : false,
    },
  });
  const list = folders.data?.folders ?? null;

  const filtered = useMemo(() => {
    if (!list) return [];
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length === 0 ? list : list.filter((f) => words.every((w) => f.toLowerCase().includes(w)));
  }, [list, search]);
  const shown = filtered.slice(0, MAX_ROWS);
  const node = activeNodes.find((n) => n.id === nodeId) ?? null;
  const selectedListed = selected !== null && (list ?? []).includes(selected);

  const pick = (folder: string) => {
    onPick(folder);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scegli la cartella sul nodo</DialogTitle>
          <DialogDescription>
            Sottocartelle della radice del nodo, fino a 3 livelli. Una cartella appena creata compare entro 30 secondi.
          </DialogDescription>
        </DialogHeader>

        {nodes.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : activeNodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun nodo attivo: creane uno in Account → «Nodi» e installalo sul Mac.</p>
        ) : (
          <div className="min-w-0 space-y-3">
            {activeNodes.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="folder-picker-node">Nodo</Label>
                <Select value={nodeId === null ? "" : String(nodeId)} onValueChange={(v) => setNodeId(Number(v))}>
                  <SelectTrigger id="folder-picker-node">
                    <SelectValue placeholder="Scegli un nodo" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeNodes.map((n) => (
                      <SelectItem key={n.id} value={String(n.id)}>
                        {n.name}
                        {n.online ? "" : " (non in linea)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {node && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={node.online ? "default" : "secondary"}>{node.online ? "online" : "non in linea"}</Badge>
                {activeNodes.length === 1 && <span className="font-medium text-foreground">{node.name}</span>}
                {folders.data?.workspaceRoot && (
                  <span className="min-w-0 break-all">
                    radice <span className="font-mono">{folders.data.workspaceRoot}</span>
                  </span>
                )}
              </div>
            )}

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Cerca una cartella"
                placeholder="Cerca per nome, es. aimag 1174"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
                autoFocus
              />
            </div>

            {folders.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : folders.isError ? (
              <p className="text-sm text-destructive">Cartelle non leggibili: riprova tra poco.</p>
            ) : list === null ? (
              <p className="text-sm text-muted-foreground">
                Il nodo non ha ancora comunicato le cartelle. Serve <span className="font-mono">casello-nodo</span> aggiornato: ricostruiscilo e
                rilancia <span className="font-mono">install</span>, poi le cartelle arrivano con l'heartbeat successivo.
              </p>
            ) : list.length === 0 ? (
              <p className="text-sm text-muted-foreground">La radice del nodo non ha sottocartelle: creane una sul Mac.</p>
            ) : (
              <div className="space-y-1.5">
                <ul role="listbox" aria-label="Cartelle del nodo" className="h-72 overflow-y-auto overflow-x-hidden rounded-md border p-1">
                  {shown.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">Nessuna cartella corrisponde alla ricerca.</li>}
                  {shown.map((f) => {
                    const cut = f.lastIndexOf("/");
                    const isSelected = f === selected;
                    const Icon = isSelected ? FolderOpen : Folder;
                    return (
                      <li key={f} role="option" aria-selected={isSelected}>
                        <button
                          type="button"
                          onClick={() => setSelected(f)}
                          onDoubleClick={() => pick(f)}
                          className={`flex w-full min-w-0 items-start gap-2 rounded px-2 py-1.5 text-left font-mono text-sm hover:bg-muted ${
                            isSelected ? "bg-primary/10 text-foreground" : ""
                          }`}
                        >
                          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 break-all">
                            <span className="text-muted-foreground">{cut >= 0 ? f.slice(0, cut + 1) : ""}</span>
                            <span className="font-medium">{cut >= 0 ? f.slice(cut + 1) : f}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-xs text-muted-foreground">
                  {filtered.length > MAX_ROWS
                    ? `Mostrate ${MAX_ROWS} di ${filtered.length}: affina la ricerca.`
                    : `${filtered.length} ${filtered.length === 1 ? "cartella" : "cartelle"}`}
                  {list.length >= NODE_FOLDERS_MAX && " · il nodo ne manda al massimo 2 000: quelle più in profondità possono mancare."}
                  {folders.data?.foldersUpdatedAt && ` · aggiornate ${formatRelative(folders.data.foldersUpdatedAt)}`}
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:items-center">
          {selected !== null && !selectedListed && list !== null && (
            <p className="mr-auto text-xs text-muted-foreground">La cartella attuale non è tra quelle del nodo.</p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          <Button disabled={!selectedListed} onClick={() => selected !== null && pick(selected)}>
            Usa questa cartella
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
