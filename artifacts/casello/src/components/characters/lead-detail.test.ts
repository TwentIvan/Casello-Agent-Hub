import { describe, expect, it } from "vitest";
import type { LeadConversationDetail } from "@workspace/api-client-react";
import { LEAD_GONE, mapLeadDetail } from "./lead-detail";

const base: LeadConversationDetail = {
  id: 1,
  title: "t",
  agentId: 5,
  aiModelId: 9,
  createdAt: "2026-11-13T10:00:00Z",
  updatedAt: "2026-11-13T10:00:00Z",
  turnStatus: "idle",
  tokensUsed: 0,
  costUsd: 0,
  messages: [],
  progress: null,
};
const run = (id: number, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, status, output: null, error: null, costUsd: null, items: [], ...extra }) as never;

describe("mapLeadDetail", () => {
  it("risposta, errore, run in corso e run sparita", () => {
    const d = mapLeadDetail({
      ...base,
      messages: [
        { id: 1, content: "a", pageContext: null, createdAt: base.createdAt, run: run(10, "succeeded", { output: "fatto", items: [{ number: 7, kind: "proposal", status: "pending", summary: "Crea" }] }) },
        { id: 2, content: "b", pageContext: null, createdAt: base.createdAt, run: run(11, "failed", { error: "boom" }) },
        { id: 3, content: "c", pageContext: null, createdAt: base.createdAt, run: run(12, "cancelled") },
        { id: 4, content: "d", pageContext: null, createdAt: base.createdAt, run: null },
        { id: 5, content: "e", pageContext: { page: "team", id: "1" }, createdAt: base.createdAt, run: run(13, "running") },
      ],
    });
    expect(d.messages).toEqual([
      { id: 2, role: "user", content: "a", error: false },
      { id: 3, role: "assistant", content: "fatto", error: false },
      { id: 4, role: "user", content: "b", error: false },
      { id: 5, role: "assistant", content: "boom", error: true },
      { id: 6, role: "user", content: "c", error: false },
      { id: 7, role: "assistant", content: "run non riuscita", error: true },
      { id: 8, role: "user", content: "d", error: false },
      { id: 9, role: "assistant", content: LEAD_GONE, error: true },
      { id: 10, role: "user", content: "e", error: false },
    ]);
    expect(d.proposals.map((p) => [p.messageId, p.payload])).toEqual([
      [3, { runId: 10, items: [{ number: 7, kind: "proposal", status: "pending", summary: "Crea" }] }],
      [5, { runId: 11, items: [] }],
      [7, { runId: 12, items: [] }],
    ]);
    expect(d.readOnlyReason).toBeNull();
  });
});
