// Esito del collaudo accanto alla voce «Porta in produzione» (console, centralino, Alfred)

import { desc, inArray } from "drizzle-orm";
import { db, releaseTestsTable, teamWorksTable } from "@workspace/db";

export interface ReleaseTestBrief {
  id: number;
  status: "queued" | "dispatching" | "running" | "done" | "failed" | "skipped" | "cancelled";
  outcome: "ok" | "problems" | "not_startable" | null;
  /** Prima riga del resoconto, al più 300 caratteri (dato non attendibile). */
  summary: string | null;
}

const SUMMARY_MAX = 300;

/** Prima riga non vuota del resoconto, ripulita dal Markdown più comune e tagliata. */
export function reportSummary(report: string | null): string | null {
  if (!report) return null;
  const line = report
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find((l) => l !== "");
  if (!line) return null;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** Ultimo collaudo del lavoro di ognuna delle voci date (per id della voce `release`). */
export async function releaseTestsForActions(actionIds: number[]): Promise<Map<number, ReleaseTestBrief>> {
  const out = new Map<number, ReleaseTestBrief>();
  if (actionIds.length === 0) return out;
  const works = await db
    .select({ id: teamWorksTable.id, actionId: teamWorksTable.pendingActionId })
    .from(teamWorksTable)
    .where(inArray(teamWorksTable.pendingActionId, actionIds));
  if (works.length === 0) return out;
  const tests = await db
    .select({ id: releaseTestsTable.id, workId: releaseTestsTable.workId, status: releaseTestsTable.status, outcome: releaseTestsTable.outcome, report: releaseTestsTable.report })
    .from(releaseTestsTable)
    .where(inArray(releaseTestsTable.workId, works.map((w) => w.id)))
    .orderBy(desc(releaseTestsTable.id));
  for (const work of works) {
    if (work.actionId === null) continue;
    const latest = tests.find((t) => t.workId === work.id);
    if (latest) out.set(work.actionId, { id: latest.id, status: latest.status, outcome: latest.outcome, summary: reportSummary(latest.report) });
  }
  return out;
}
