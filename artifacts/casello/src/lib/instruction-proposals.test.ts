import { describe, expect, it } from "vitest";
import type { CharacterInstructionProposal } from "@workspace/api-client-react";
import { instructionCardState, proposalsByMessage } from "./instruction-proposals";

const make = (id: number, messageId: number | null): CharacterInstructionProposal => ({
  id,
  character: "lucius",
  content: "nuovo",
  reason: "motivo",
  status: "pending",
  baseVersion: 1,
  currentContent: "vecchio",
  messageId,
  createdAt: "2026-11-17T10:00:00Z",
});

describe("instructionCardState", () => {
  it("descrive i quattro stati", () => {
    expect(instructionCardState({ status: "pending" })).toEqual({ led: "ask", label: "Da decidere", canDecide: true });
    expect(instructionCardState({ status: "accepted" })).toEqual({ led: "ok", label: "Accettata", canDecide: false });
    expect(instructionCardState({ status: "rejected" })).toEqual({ led: "idle", label: "Rifiutata", canDecide: false });
    expect(instructionCardState({ status: "stale" })).toEqual({
      led: "idle",
      label: "Superata: chiedi una proposta aggiornata",
      canDecide: false,
    });
  });
});

describe("proposalsByMessage", () => {
  it("raggruppa per messaggio e manda in fondo le altre", () => {
    const list = [make(1, 10), make(2, null), make(3, 99), make(4, 10)];
    const { byMessage, trailing } = proposalsByMessage(list, [10, 11]);
    expect(byMessage.get(10)?.map((p) => p.id)).toEqual([1, 4]);
    expect(byMessage.has(11)).toBe(false);
    expect(trailing.map((p) => p.id)).toEqual([2, 3]);
  });
});
