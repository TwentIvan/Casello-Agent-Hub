import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import {
  type CharacterConversationDetail,
  getGetAlfredThreadQueryKey,
  getGetCharacterConversationQueryKey,
  getListCharacterConversationsQueryKey,
  useCreateCharacterConversation,
  useDecideCharacterProposal,
  useDeleteCharacterConversation,
  useGetAlfredThread,
  useGetCharacterConversation,
  useListCharacterConversations,
  useRestartAlfredThread,
  useSendCharacterMessage,
  useUpdateCharacterConversation,
} from "@workspace/api-client-react";
import {
  POLL_MS,
  SUBJECT_LABELS,
  useInvalidateOnTurnEnd,
  type ChatAdapter,
  type ChatTarget,
  type ConvDetail,
  type PageContext,
  type SubjectType,
} from "./adapters";

// Adattatori delle conversazioni dei personaggi (route /character-conversations): filo di Alfred e argomenti di Lucius.

const AREA_TYPES = new Set<SubjectType>(["area_agents", "area_skills", "area_team_templates"]);

/** Query delle conversazioni dei personaggi (dettaglio e elenchi): chiavi /api/character-conversations… */
const isCharacterConversationQuery = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && head.startsWith("/api/character-conversations");
};

/** Oggetti che una scheda accettata può cambiare: agenti, strumenti, skill, modelli, coda, squadre. */
const ACCEPT_PREFIXES = ["/api/agents", "/api/apps", "/api/skills", "/api/team-templates", "/api/pending-actions", "/api/dashboard", "/api/team-instances"];
const isAcceptTouchedQuery = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && ACCEPT_PREFIXES.some((p) => head.startsWith(p));
};

function readOnlyReasonOf(d: CharacterConversationDetail): string | null {
  if (d.archivedAt !== null) return "Conversazione archiviata: si può solo leggere.";
  if (d.subjectGone) return "L'argomento è stato eliminato: la conversazione si può solo leggere.";
  return null;
}

function mapCharacterDetail(d: CharacterConversationDetail): ConvDetail {
  return {
    id: d.id,
    title: d.title,
    aiModelId: d.aiModelId,
    tokensUsed: d.tokensUsed,
    costUsd: d.costUsd,
    turnStatus: d.turnStatus,
    readOnlyReason: readOnlyReasonOf(d),
    subjectId: d.subjectId,
    messages: d.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, error: m.error })),
    proposals: d.proposals.map((p) => ({
      id: p.id,
      messageId: p.messageId,
      kind: p.kind,
      status: p.status,
      payload: p.payload,
      rationale: p.rationale,
      raw: p,
    })),
  };
}

function useCharacterMutations(queryClient: QueryClient) {
  const send = useSendCharacterMessage();
  const update = useUpdateCharacterConversation();
  const decide = useDecideCharacterProposal();
  const refresh = () => void queryClient.invalidateQueries({ predicate: isCharacterConversationQuery });
  return {
    refresh,
    async send(id: number, content: string, pageContext?: PageContext) {
      try {
        await send.mutateAsync({ id, data: pageContext ? { content, pageContext } : { content } });
      } finally {
        refresh();
      }
    },
    async setModel(id: number, aiModelId: number) {
      try {
        await update.mutateAsync({ id, data: { aiModelId } });
      } finally {
        refresh();
      }
    },
    async decide(proposalId: number, action: "accept" | "reject") {
      try {
        await decide.mutateAsync({ id: proposalId, data: { action } });
        if (action === "accept") void queryClient.invalidateQueries({ predicate: isAcceptTouchedQuery });
      } finally {
        // Anche dopo un 409 (scheda superata, voce cambiata): si rilegge lo stato vero
        refresh();
      }
    },
  };
}

export function useAlfredAdapter(page: PageContext): ChatAdapter {
  const queryClient = useQueryClient();
  const common = useCharacterMutations(queryClient);
  const restart = useRestartAlfredThread();
  const threadKey = getGetAlfredThreadQueryKey();
  const refreshThread = () => void queryClient.invalidateQueries({ queryKey: threadKey });

  return {
    character: "alfred",
    subjectLabel: "Il filo di Alfred",
    emptyHint: "Chiedi ad Alfred delle squadre, della coda da confermare o delle run.",
    useConversations: () => null,
    useConversation: () => {
      // GET crea il filo se manca
      const q = useGetAlfredThread({
        query: {
          queryKey: threadKey,
          refetchInterval: (query) => (query.state.data?.turnStatus === "running" ? POLL_MS : false),
        },
      });
      return { data: q.data ? mapCharacterDetail(q.data) : undefined, isLoading: q.isLoading, error: q.error ?? undefined };
    },
    // Il filo non si crea a mano (lo crea la GET): `create` restituisce quello che c'è
    create: async () => {
      const detail = queryClient.getQueryData<CharacterConversationDetail>(threadKey);
      if (!detail) throw new Error("filo di Alfred non ancora caricato");
      return detail.id;
    },
    restart: async () => {
      const detail = await restart.mutateAsync();
      queryClient.setQueryData(threadKey, detail);
      return detail.id;
    },
    send: async (id, content) => {
      try {
        await common.send(id, content, page);
      } finally {
        refreshThread();
      }
    },
    setModel: async (id, aiModelId) => {
      try {
        await common.setModel(id, aiModelId);
      } finally {
        refreshThread();
      }
    },
    decide: async (proposalId, decision) => {
      try {
        await common.decide(proposalId, decision);
      } finally {
        refreshThread();
      }
    },
  };
}

export function useLuciusSubjectAdapter(target: Extract<ChatTarget, { kind: "character" }>): ChatAdapter {
  const queryClient = useQueryClient();
  const common = useCharacterMutations(queryClient);
  const createConv = useCreateCharacterConversation();
  const update = useUpdateCharacterConversation();
  const removeConv = useDeleteCharacterConversation();
  const params = {
    character: "lucius" as const,
    subjectType: target.subjectType,
    ...(target.subjectId !== null ? { subjectId: target.subjectId } : {}),
  };
  const list = useListCharacterConversations(params, { query: { queryKey: getListCharacterConversationsQueryKey(params) } });

  const typeLabel = SUBJECT_LABELS[target.subjectType];
  const title = target.title || list.data?.[0]?.subjectTitle || target.subjectId || "";
  const subjectLabel = AREA_TYPES.has(target.subjectType) || !title ? typeLabel : `${typeLabel} · ${title}`;

  return {
    character: "lucius",
    subjectLabel,
    emptyHint: "Chiedi a Lucius di scrivere o rivedere: cambia solo quello che accetti.",
    deleteNote: "I messaggi e le schede non decise vanno persi; quelle già accettate restano.",
    useConversations: () => ({
      items: (list.data ?? []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, tokensUsed: c.tokensUsed, costUsd: c.costUsd })),
      isLoading: list.isLoading,
      error: list.error ?? undefined,
    }),
    useConversation: (id) => {
      const q = useGetCharacterConversation(id ?? 0, {
        query: {
          queryKey: getGetCharacterConversationQueryKey(id ?? 0),
          enabled: id !== null,
          refetchInterval: (query) => (query.state.data?.turnStatus === "running" ? POLL_MS : false),
        },
      });
      useInvalidateOnTurnEnd(q.data?.turnStatus === "running", common.refresh);
      return { data: q.data ? mapCharacterDetail(q.data) : undefined, isLoading: q.isLoading && id !== null, error: q.error ?? undefined };
    },
    create: async (modelId) => {
      const created = await createConv.mutateAsync({
        data: { character: "lucius", subjectType: target.subjectType, subjectId: target.subjectId },
      });
      // Il modello si sceglie dopo: senza scelta la conversazione usa il modello di Lucius
      if (modelId !== null) await update.mutateAsync({ id: created.id, data: { aiModelId: modelId } });
      common.refresh();
      return created.id;
    },
    remove: async (id) => {
      try {
        await removeConv.mutateAsync({ id });
      } finally {
        common.refresh();
      }
    },
    send: (id, content) => common.send(id, content),
    setModel: common.setModel,
    decide: common.decide,
  };
}
