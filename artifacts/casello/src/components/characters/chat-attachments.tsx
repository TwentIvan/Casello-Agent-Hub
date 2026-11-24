import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { deleteChatAttachment, getGetChatAttachmentUrl, uploadChatAttachment, type ChatAttachment } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/api-errors";
import { CHAT_ATTACHMENT_ACCEPT, attachmentFileError, formatBytes } from "@/lib/chat-attachments";
import type { InstructionConversationKind } from "./use-instruction-proposals";
import type { ChatMessageAttachment } from "./adapters";

// Allegati nelle chat (issue #120): immagini e PDF caricati dal campo di scrittura e mandati con il messaggio. Il file
// va subito al server (`POST /chat-attachments`), il messaggio porta solo gli id.

/**
 * Allegati pronti per il prossimo messaggio della conversazione. Cambiando conversazione l'elenco si svuota (quelli
 * caricati e non mandati il server li toglie dopo un giorno).
 */
export function usePendingAttachments(kind: InstructionConversationKind | undefined, conversationId: number | null) {
  const { toast } = useToast();
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  // Si svuota solo passando da una conversazione a un'altra: la prima conversazione creata dal primo allegato la tiene
  const previous = useRef(conversationId);
  useEffect(() => {
    if (previous.current !== null && previous.current !== conversationId) setPending([]);
    previous.current = conversationId;
  }, [conversationId]);

  const add = async (files: File[], ensureConversation: () => Promise<number>) => {
    if (!kind) return;
    let count = pending.length;
    let conversation: number | null = null;
    for (const file of files) {
      const error = attachmentFileError(file, count);
      if (error) {
        toast({ variant: "destructive", title: "Allegato non caricato", description: error });
        continue;
      }
      count++;
      setUploading((n) => n + 1);
      try {
        conversation ??= await ensureConversation();
        const saved = await uploadChatAttachment(file, { conversationKind: kind, conversationId: conversation }, {
          headers: { "X-Attachment-Name": encodeURIComponent(file.name), "Content-Type": "application/octet-stream" },
        });
        setPending((list) => [...list, saved]);
      } catch (err) {
        count--;
        toast({ variant: "destructive", title: "Allegato non caricato", description: apiErrorMessage(err) });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const remove = (id: number) => {
    setPending((list) => list.filter((a) => a.id !== id));
    // Se non riesce resta sul server e si cancella da solo dopo un giorno
    void deleteChatAttachment(id).catch(() => {});
  };

  return { enabled: kind !== undefined, pending, uploading: uploading > 0, add, remove, clear: () => setPending([]) };
}

const iconFor = (contentType: string) => (contentType.startsWith("image/") ? ImageIcon : FileText);

/** Pulsante «Allega» con il selettore dei file (immagini e PDF). */
export function AttachButton({ disabled, onFiles }: { disabled: boolean; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="Allega immagini (PNG, JPEG, WebP) o PDF, al massimo 10 MB l'uno"
      >
        <Paperclip />
        Allega
      </Button>
    </>
  );
}

/** Allegati pronti nel campo di scrittura, con «Togli». */
export function PendingAttachments({ items, onRemove, disabled }: { items: ChatAttachment[]; onRemove: (id: number) => void; disabled: boolean }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Allegati del messaggio">
      {items.map((a) => {
        const Icon = iconFor(a.contentType);
        return (
          <li key={a.id} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
            <Icon className="size-3.5 shrink-0 text-ink-muted" />
            <span className="min-w-0 truncate">{a.name}</span>
            <span className="shrink-0 font-mono text-ink-muted">{formatBytes(a.sizeBytes)}</span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-ink-muted hover:text-ink disabled:opacity-50"
              onClick={() => onRemove(a.id)}
              disabled={disabled}
              aria-label={`Togli ${a.name}`}
            >
              <X className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Allegati di un messaggio mandato. Con `downloadable` (console: c'è il cookie di sessione) il nome scarica il file; nel
 * pannello incorporato si mostra solo il nome.
 */
export function MessageAttachments({ items, downloadable }: { items: ChatMessageAttachment[]; downloadable: boolean }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Allegati">
      {items.map((a) => {
        const Icon = iconFor(a.contentType);
        const label = (
          <>
            <Icon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{a.name}</span>
            <span className="shrink-0 font-mono text-ink-muted">{formatBytes(a.sizeBytes)}</span>
          </>
        );
        return (
          <li key={a.id} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
            {downloadable ? (
              <a href={getGetChatAttachmentUrl(a.id)} download={a.name} className="flex min-w-0 items-center gap-1 hover:underline">
                {label}
              </a>
            ) : (
              label
            )}
          </li>
        );
      })}
    </ul>
  );
}
