// Adattatore di `CharacterChat` per la chat con un Responsabile di prodotto: ogni messaggio è una run.
// Senza `app` è Barbara, la Responsabile di Botcave (console); con `app` il Responsabile di quell'App (pannello incorporato).
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetLeadConversationQueryKey,
  getLeadConversation,
  getListLeadConversationsQueryKey,
  listLeadConversations,
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
import { writeTo } from "./targets";

/** Pagina da cui si scrive: della console (`page`, `id`) o dell'app ospite (`page: "host"` con `host`). */
export type LeadPage = Pick<LeadPageContext, "id" | "host"> & { page: string };

/** Esito di un'azione della barra del contesto: `busy` = la run precedente è ancora aperta, non si è mandato nulla. */
export type LeadActionResult = "sent" | "busy";

export interface LeadChatAdapter extends ChatAdapter {
  /** Manda l'azione della pagina con quell'etichetta nella conversazione più recente (creata se non c'è). */
  sendAction(label: string): Promise<LeadActionResult>;
}

export function useLeadChatAdapter(page: LeadPage | null, opts?: { app?: string; leadName?: string }): LeadChatAdapter {
  const queryClient = useQueryClient();
  const app = opts?.app;
  const params = app ? { app } : undefined;
  const listKey = getListLeadConversationsQueryKey(params);
  const detailKey = (id: number) => getGetLeadConversationQueryKey(id, params);
  const list = useListLeadConversations(params, { query: { queryKey: listKey } });
  const createConv = useCreateLeadConversation();
  const removeConv = useDeleteLeadConversation();
  const send = useSendLeadMessage();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: listKey });
  const pageContext = (page ?? undefined) as LeadPageContext | undefined;
  const name = opts?.leadName;

  const createOne = async (): Promise<number> => {
    try {
      const created = await createConv.mutateAsync({ params });
      return created.id;
    } finally {
      refresh();
    }
  };

  return {
    character: "responsabile",
    subjectLabel: name ? `${name} · Responsabile di prodotto` : "Barbara, la Responsabile di Botcave",
    emptyHint: name
      ? `Chiedi ${writeTo(name)}, il Responsabile di prodotto di questa app: conosce i suoi strumenti. Le scritture le propone in Da confermare.`
      : "Chiedi a Barbara, la Responsabile di Botcave: conosce squadre, agenti, run, skill e coda. Le scritture le propone in Da confermare.",
    deleteNote: "Le run restano nella pagina Run.",
    createWithoutDialog: true,
    maxChars: 4000,
    useConversations: () => ({
      items: (list.data ?? []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, tokensUsed: c.tokensUsed, costUsd: c.costUsd })),
      isLoading: list.isLoading,
      error: list.error ?? undefined,
    }),
    useConversation: (id) => {
      const q = useGetLeadConversation(id ?? 0, params, {
        query: {
          queryKey: detailKey(id ?? 0),
          enabled: id !== null,
          refetchInterval: (query) => (query.state.data?.turnStatus === "running" ? POLL_MS : false),
        },
      });
      useInvalidateOnTurnEnd(q.data?.turnStatus === "running", refresh);
      return { data: q.data ? mapLeadDetail(q.data) : undefined, isLoading: q.isLoading && id !== null, error: q.error ?? undefined };
    },
    create: () => createOne(),
    remove: async (id) => {
      try {
        await removeConv.mutateAsync({ id, params });
        forgetConversation(queryClient, listKey, detailKey(id), id);
      } finally {
        refresh();
      }
    },
    send: async (id, content) => {
      try {
        // La pagina letta al momento dell'invio: ogni messaggio porta la sua
        await send.mutateAsync({ id, data: { content, pageContext }, params });
      } finally {
        void queryClient.invalidateQueries({ queryKey: detailKey(id) });
        refresh();
      }
    },
    sendAction: async (label) => {
      // Elenco e conversazione riletti adesso: la scheda può essere appena montata e la cache vecchia
      const items = await queryClient.fetchQuery({ queryKey: listKey, queryFn: () => listLeadConversations(params), staleTime: 0 });
      let id = items[0]?.id ?? null;
      if (id !== null) {
        const openId = id;
        const detail = await queryClient.fetchQuery({
          queryKey: detailKey(openId),
          queryFn: () => getLeadConversation(openId, params),
          staleTime: 0,
        });
        if (detail.turnStatus === "running") return "busy";
      } else {
        id = await createOne();
      }
      try {
        // La richiesta la prende il server dalle azioni salvate dell'App: dal browser arrivano solo etichetta e pagina
        await send.mutateAsync({ id, data: { content: label, pageContext, actionLabel: label }, params });
      } finally {
        void queryClient.invalidateQueries({ queryKey: detailKey(id) });
        refresh();
      }
      return "sent";
    },
    // Le «schede» sono solo il riepilogo della run (voci in coda e collegamento): nessuna decisione qui
    decide: async () => {},
    renderProposal: (p) => (p.kind === LEAD_RUN_KIND ? <LeadRunCard payload={p.payload as LeadRunPayload} /> : null),
  };
}
