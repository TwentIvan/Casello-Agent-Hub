// Adattatore di `CharacterChat` per la chat con il Responsabile di prodotto di Botcave: ogni messaggio è una run.
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetLeadConversationQueryKey,
  getListLeadConversationsQueryKey,
  useCreateLeadConversation,
  useDeleteLeadConversation,
  useGetLeadConversation,
  useListLeadConversations,
  useSendLeadMessage,
  type LeadPageContext,
} from "@workspace/api-client-react";
import { POLL_MS, forgetConversation, useInvalidateOnTurnEnd, type ChatAdapter } from "./adapters";
import { LeadRunCard } from "./lead-run-card";
import { LEAD_RUN_KIND, mapLeadDetail, type LeadRunPayload } from "./lead-detail";

export function useLeadChatAdapter(page: { page: string; id?: string }): ChatAdapter {
  const queryClient = useQueryClient();
  const listKey = getListLeadConversationsQueryKey();
  const list = useListLeadConversations({ query: { queryKey: listKey } });
  const createConv = useCreateLeadConversation();
  const removeConv = useDeleteLeadConversation();
  const send = useSendLeadMessage();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: listKey });

  return {
    character: "responsabile",
    subjectLabel: "Responsabile di prodotto di Botcave",
    emptyHint:
      "Chiedi al Responsabile di Botcave: conosce squadre, agenti, run, skill e coda. Le scritture le propone in Da confermare.",
    deleteNote: "Le run restano nella pagina Run.",
    createWithoutDialog: true,
    maxChars: 4000,
    useConversations: () => ({
      items: (list.data ?? []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, tokensUsed: c.tokensUsed, costUsd: c.costUsd })),
      isLoading: list.isLoading,
      error: list.error ?? undefined,
    }),
    useConversation: (id) => {
      const q = useGetLeadConversation(id ?? 0, {
        query: {
          queryKey: getGetLeadConversationQueryKey(id ?? 0),
          enabled: id !== null,
          refetchInterval: (query) => (query.state.data?.turnStatus === "running" ? POLL_MS : false),
        },
      });
      useInvalidateOnTurnEnd(q.data?.turnStatus === "running", refresh);
      return { data: q.data ? mapLeadDetail(q.data) : undefined, isLoading: q.isLoading && id !== null, error: q.error ?? undefined };
    },
    create: async () => {
      try {
        const created = await createConv.mutateAsync();
        return created.id;
      } finally {
        refresh();
      }
    },
    remove: async (id) => {
      try {
        await removeConv.mutateAsync({ id });
        forgetConversation(queryClient, listKey, getGetLeadConversationQueryKey(id), id);
      } finally {
        refresh();
      }
    },
    send: async (id, content) => {
      try {
        // La pagina letta al momento dell'invio: ogni messaggio porta la sua
        await send.mutateAsync({ id, data: { content, pageContext: page as LeadPageContext } });
      } finally {
        void queryClient.invalidateQueries({ queryKey: getGetLeadConversationQueryKey(id) });
        refresh();
      }
    },
    // Le «schede» sono solo il riepilogo della run (voci in coda e collegamento): nessuna decisione qui
    decide: async () => {},
    renderProposal: (p) => (p.kind === LEAD_RUN_KIND ? <LeadRunCard payload={p.payload as LeadRunPayload} /> : null),
  };
}
