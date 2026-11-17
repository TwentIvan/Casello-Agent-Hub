import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListCharacterInstructionProposalsQueryKey,
  useListCharacterInstructionProposals,
  type ListCharacterInstructionProposalsConversationKind,
} from "@workspace/api-client-react";

export type InstructionConversationKind = ListCharacterInstructionProposalsConversationKind;

const REFETCH_MS = 2000;

/** Schede di istruzioni personali di una conversazione: si rileggono ogni 2 s durante il turno e una volta alla fine. */
export function useInstructionProposals(
  kind: InstructionConversationKind | undefined,
  conversationId: number | null,
  running: boolean,
) {
  const queryClient = useQueryClient();
  const enabled = kind !== undefined && conversationId !== null;
  const params = { conversationKind: kind ?? "character", conversationId: conversationId ?? 1 };
  const key = getListCharacterInstructionProposalsQueryKey(params);
  const query = useListCharacterInstructionProposals(params, {
    query: { queryKey: key, enabled, refetchInterval: running ? REFETCH_MS : false },
  });
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && enabled) void queryClient.invalidateQueries({ queryKey: key });
    wasRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  return {
    proposals: enabled ? (query.data ?? []) : [],
    refresh: () => void queryClient.invalidateQueries({ queryKey: key }),
  };
}
