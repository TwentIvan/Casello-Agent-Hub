import { useRef, useState } from "react";
import { Download, Trash2, Upload } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type TeamAttachment,
  getGetTeamAttachmentUrl,
  getListTeamAttachmentsQueryKey,
  uploadTeamAttachment,
  useDeleteTeamAttachment,
  useListTeamAttachments,
} from "@workspace/api-client-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { formatRelative } from "@/lib/format";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("it-IT", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;
}

/**
 * «Allegati» della squadra: file che il nodo scarica nello spazio di lavoro a ogni compito (max 10 MB l'uno, 50 MB per
 * squadra). Il corpo è il file grezzo, il nome viaggia nell'header `X-Attachment-Name`.
 */
export function TeamAttachments({ teamId, readOnly }: { teamId: number; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = useState<TeamAttachment | null>(null);
  const attachments = useListTeamAttachments(teamId, { query: { queryKey: getListTeamAttachmentsQueryKey(teamId) } });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: getListTeamAttachmentsQueryKey(teamId) });
  const total = (attachments.data ?? []).reduce((sum, a) => sum + a.sizeBytes, 0);

  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadTeamAttachment(teamId, file, {
        headers: {
          "X-Attachment-Name": encodeURIComponent(file.name),
          "Content-Type": file.type || "application/octet-stream",
        },
      }),
    onSuccess: (saved) => {
      refresh();
      toast({ title: "Allegato caricato", description: saved.name });
    },
    onError: (error) => toast({ variant: "destructive", title: "Caricamento non riuscito", description: apiErrorMessage(error) }),
  });
  const remove = useDeleteTeamAttachment({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Allegato eliminato", description: deleting?.name });
        setDeleting(null);
      },
      onError: (error) => {
        setDeleting(null);
        toast({ variant: "destructive", title: "Impossibile eliminare l'allegato", description: apiErrorMessage(error) });
      },
    },
  });

  const pick = (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast({
        variant: "destructive",
        title: "File troppo grande",
        description: `«${file.name}» pesa ${formatBytes(file.size)}: il massimo è ${formatBytes(MAX_FILE_BYTES)} per file.`,
      });
      return;
    }
    upload.mutate(file);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Allegati</CardTitle>
          <CardDescription>
            File che il nodo scarica nello spazio di lavoro a ogni compito. Massimo {formatBytes(MAX_FILE_BYTES)} per file e{" "}
            {formatBytes(MAX_TOTAL_BYTES)} per squadra{attachments.data ? ` (usati ${formatBytes(total)})` : ""}.
          </CardDescription>
        </div>
        {!readOnly && (
          <>
            <input ref={input} type="file" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
            <Button size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
              <Upload />
              {upload.isPending ? "Caricamento…" : "Carica un file"}
            </Button>
          </>
        )}
      </CardHeader>
      <CardContent>
        {attachments.isError ? (
          <p className="text-sm text-destructive">Impossibile caricare gli allegati: {apiErrorMessage(attachments.error)}</p>
        ) : !attachments.data ? (
          <Skeleton className="h-12 w-full" />
        ) : attachments.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nessun allegato.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {attachments.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="break-all text-sm font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(a.sizeBytes)} · caricato {formatRelative(a.createdAt)}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button asChild variant="outline" size="sm">
                    <a href={getGetTeamAttachmentUrl(teamId, a.id)} download={a.name}>
                      <Download />
                      Scarica
                    </a>
                  </Button>
                  {!readOnly && (
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => setDeleting(a)}>
                      <Trash2 />
                      Elimina
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Eliminare l'allegato?"
        description={`«${deleting?.name ?? ""}» non sarà più disponibile per i prossimi compiti del nodo. I compiti già assegnati lo scaricano comunque.`}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: teamId, attachmentId: deleting.id })}
      />
    </Card>
  );
}
