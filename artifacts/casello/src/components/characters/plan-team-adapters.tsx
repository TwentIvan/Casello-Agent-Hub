import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  type PlanConversationDetail,
  type PlanProposal,
  type TeamChatConversationDetail,
  type TeamChatProposal,
  getGetAppPlanQueryKey,
  getGetAppQueryKey,
  getGetPlanConversationQueryKey,
  getGetTeamChatConversationQueryKey,
  getGetTeamInstanceQueryKey,
  getListPlanConversationsQueryKey,
  getListTeamChatConversationsQueryKey,
  useCreatePlanConversation,
  useCreateTeamChatConversation,
  useDecidePlanProposal,
  useDecideTeamChatProposal,
  useDeletePlanConversation,
  useDeleteTeamChatConversation,
  useGetApp,
  useGetAppPlan,
  useGetPlanConversation,
  useGetTeamChatConversation,
  useGetTeamInstance,
  useListPlanConversations,
  useListTeamChatConversations,
  useSendPlanMessage,
  useSendTeamChatMessage,
  useUpdatePlanConversation,
} from "@workspace/api-client-react";
import { ProposalCard } from "@/components/plan/proposal-card";
import { RoleInstructionsCard } from "@/components/teams/role-instructions-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { forgetConversation, POLL_MS, useInvalidateOnTurnEnd, type ChatAdapter, type ConvDetail, type ProposalLike } from "./adapters";

// Adattatori dei backend di oggi: chat del piano (Lucius sul piano dell'app) e chat di squadra (Lucius sui ruoli).

type AnyDetail = PlanConversationDetail | TeamChatConversationDetail;

function mapCommon(d: AnyDetail, readOnlyReason: string | null): Omit<ConvDetail, "proposals"> {
  return {
    id: d.id,
    title: d.title,
    aiModelId: d.aiModelId,
    tokensUsed: d.tokensUsed,
    costUsd: d.costUsd,
    turnStatus: d.turnStatus,
    readOnlyReason,
    subjectId: null,
    messages: d.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, error: m.error })),
  };
}

function toProposalLike(p: PlanProposal | TeamChatProposal): ProposalLike {
  return { id: p.id, messageId: p.messageId, kind: p.kind, status: p.status, payload: p.payload, rationale: p.rationale, raw: p };
}

const pollWhileRunning = (data: { turnStatus: string } | undefined) => (data?.turnStatus === "running" ? POLL_MS : false);

/** Chat del piano dell'app: le schede sono quelle di oggi (`ProposalCard`, che decide da sola). */
export function usePlanChatAdapter(appId: number): ChatAdapter {
  const queryClient = useQueryClient();
  const app = useGetApp(appId, { query: { queryKey: getGetAppQueryKey(appId) } });
  const plan = useGetAppPlan(appId, { query: { queryKey: getGetAppPlanQueryKey(appId) } });
  const list = useListPlanConversations(appId, { query: { queryKey: getListPlanConversationsQueryKey(appId) } });
  const create = useCreatePlanConversation();
  const send = useSendPlanMessage();
  const update = useUpdatePlanConversation();
  const decide = useDecidePlanProposal();
  const remove = useDeletePlanConversation();

  const refreshList = () => void queryClient.invalidateQueries({ queryKey: getListPlanConversationsQueryKey(appId) });
  const refreshConv = (id: number) => void queryClient.invalidateQueries({ queryKey: getGetPlanConversationQueryKey(id) });
  const refreshPlan = () => void queryClient.invalidateQueries({ queryKey: getGetAppPlanQueryKey(appId) });
  const items = plan.data?.items ?? [];

  return {
    character: "lucius",
    subjectLabel: app.data ? `Piano · ${app.data.name}` : "Piano dell'app",
    emptyHint: "Scrivi a Lucius per chiedere integrazioni, correzioni o nuove idee per il piano.",
    deleteNote: "I messaggi e le proposte non decise vanno persi; le voci già accettate restano nel piano.",
    useConversations: () => ({
      items: (list.data ?? []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, tokensUsed: c.tokensUsed, costUsd: c.costUsd })),
      isLoading: list.isLoading,
      error: list.error ?? undefined,
    }),
    useConversation: (id) => {
      const q = useGetPlanConversation(id ?? 0, {
        query: {
          queryKey: getGetPlanConversationQueryKey(id ?? 0),
          enabled: id !== null,
          refetchInterval: (query) => pollWhileRunning(query.state.data),
        },
      });
      // A fine turno cambiano costi, titolo e (con le proposte) il contesto
      useInvalidateOnTurnEnd(q.data?.turnStatus === "running", () => {
        refreshList();
        refreshPlan();
      });
      const d = q.data;
      const data: ConvDetail | undefined = d
        ? {
            ...mapCommon(d, null),
            proposals: d.proposals.map(toProposalLike),
            notice:
              d.newerAnalysisId !== null ? (
                <Alert>
                  <AlertTitle>C'è un piano più recente</AlertTitle>
                  <AlertDescription>
                    Questa conversazione è basata su un'analisi precedente.{" "}
                    <Link href={`/analyses/${d.newerAnalysisId}`} className="font-medium underline underline-offset-2">
                      Apri l'analisi #{d.newerAnalysisId}
                    </Link>
                    .
                  </AlertDescription>
                </Alert>
              ) : undefined,
          }
        : undefined;
      return { data, isLoading: q.isLoading && id !== null, error: q.error ?? undefined };
    },
    create: async (modelId) => {
      const created = await create.mutateAsync({ id: appId, data: modelId !== null ? { aiModelId: modelId } : {} });
      refreshList();
      return created.id;
    },
    remove: async (id) => {
      try {
        await remove.mutateAsync({ id });
        forgetConversation(queryClient, getListPlanConversationsQueryKey(appId), getGetPlanConversationQueryKey(id), id);
      } finally {
        refreshList();
      }
    },
    send: async (id, content) => {
      try {
        await send.mutateAsync({ id, data: { content } });
      } finally {
        refreshConv(id);
      }
    },
    setModel: async (id, aiModelId) => {
      try {
        await update.mutateAsync({ id, data: { aiModelId } });
      } finally {
        refreshConv(id);
        refreshList();
      }
    },
    decide: async (proposalId, action) => {
      try {
        await decide.mutateAsync({ id: proposalId, data: { action } });
      } finally {
        refreshPlan();
        void queryClient.invalidateQueries({
          predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/plan-conversations"),
        });
      }
    },
    renderProposal: (p) => {
      const proposal = p.raw as PlanProposal;
      return (
        <ProposalCard
          proposal={proposal}
          appId={appId}
          currentItem={proposal.targetItemId !== null ? items.find((i) => i.id === proposal.targetItemId) : undefined}
        />
      );
    },
  };
}

/** Chat di squadra: identità e istruzioni dei ruoli (`RoleInstructionsCard`); il modello non si cambia dopo la creazione. */
export function useTeamChatAdapter(instanceId: number, closed: boolean): ChatAdapter {
  const queryClient = useQueryClient();
  const team = useGetTeamInstance(instanceId, { query: { queryKey: getGetTeamInstanceQueryKey(instanceId) } });
  const list = useListTeamChatConversations(instanceId, { query: { queryKey: getListTeamChatConversationsQueryKey(instanceId) } });
  const create = useCreateTeamChatConversation();
  const send = useSendTeamChatMessage();
  const decide = useDecideTeamChatProposal();
  const remove = useDeleteTeamChatConversation();

  const isClosed = closed || team.data?.status === "closed";
  const closedReason = isClosed ? "Squadra chiusa: la conversazione si può solo leggere." : null;
  const roleNames = new Map((team.data?.roles ?? []).map((r) => [r.key, r.name]));
  const refreshList = () => void queryClient.invalidateQueries({ queryKey: getListTeamChatConversationsQueryKey(instanceId) });
  const refreshConv = (id: number) => void queryClient.invalidateQueries({ queryKey: getGetTeamChatConversationQueryKey(id) });
  const refreshAllConvs = () =>
    void queryClient.invalidateQueries({
      predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/team-chat-conversations"),
    });

  return {
    character: "lucius",
    subjectLabel: team.data ? `Squadra · ${team.data.name}` : "Squadra",
    closedReason,
    emptyHint: "Scrivi a Lucius per chiedere un'identità o istruzioni migliori per un ruolo.",
    deleteNote: "I messaggi e le schede non decise vanno persi; quelle già accettate restano nella squadra.",
    useConversations: () => ({
      items: (list.data ?? []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, tokensUsed: c.tokensUsed, costUsd: c.costUsd })),
      isLoading: list.isLoading,
      error: list.error ?? undefined,
    }),
    useConversation: (id) => {
      const q = useGetTeamChatConversation(id ?? 0, {
        query: {
          queryKey: getGetTeamChatConversationQueryKey(id ?? 0),
          enabled: id !== null,
          refetchInterval: (query) => pollWhileRunning(query.state.data),
        },
      });
      useInvalidateOnTurnEnd(q.data?.turnStatus === "running", refreshList);
      const d = q.data;
      const data: ConvDetail | undefined = d
        ? { ...mapCommon(d, closedReason), proposals: d.proposals.map(toProposalLike) }
        : undefined;
      return { data, isLoading: q.isLoading && id !== null, error: q.error ?? undefined };
    },
    create: async (modelId) => {
      const created = await create.mutateAsync({ id: instanceId, data: { aiModelId: modelId } });
      refreshList();
      return created.id;
    },
    remove: async (id) => {
      try {
        await remove.mutateAsync({ id });
        forgetConversation(queryClient, getListTeamChatConversationsQueryKey(instanceId), getGetTeamChatConversationQueryKey(id), id);
      } finally {
        refreshList();
      }
    },
    send: async (id, content) => {
      try {
        await send.mutateAsync({ id, data: { content } });
      } finally {
        refreshConv(id);
      }
    },
    decide: async (proposalId, action) => {
      try {
        await decide.mutateAsync({ id: proposalId, data: { action } });
        // Accettare cambia ruoli e skill della squadra
        if (action === "accept") void queryClient.invalidateQueries({ queryKey: getGetTeamInstanceQueryKey(instanceId) });
      } finally {
        refreshAllConvs();
        refreshList();
      }
    },
    renderProposal: (p, ctx) => {
      const proposal = p.raw as TeamChatProposal;
      return (
        <RoleInstructionsCard
          proposal={proposal}
          roleName={roleNames.get(proposal.roleKey)}
          deciding={ctx.deciding || ctx.readOnly}
          onDecide={ctx.decide}
        />
      );
    },
  };
}
