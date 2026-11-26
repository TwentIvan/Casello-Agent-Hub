// Esito del collaudo accanto alla voce «Porta in produzione» (console, centralino, Alfred): l'ultimo collaudo completo
// (`full`) del lavoro, con a parte lo stato e il link dal vivo del «Riaccendi» più recente.

import { desc, inArray } from "drizzle-orm";
import { db, releaseTestsTable, teamWorksTable } from "@workspace/db";

type TestStatus = "queued" | "dispatching" | "running" | "done" | "failed" | "skipped" | "cancelled";

export interface ReleaseRelightBrief {
  id: number;
  status: TestStatus;
  /** Motivo fisso se la riaccensione non è riuscita. */
  error: string | null;
  /** Link dal vivo, solo finché è valido. */
  tunnelUrl: string | null;
  tunnelUntil: Date | null;
}

export interface ReleaseTestBrief {
  /** Ultimo collaudo completo del lavoro. */
  id: number;
  status: TestStatus;
  outcome: "ok" | "problems" | "not_startable" | null;
  /** Prima riga del resoconto, al più 300 caratteri (dato non attendibile). */
  summary: string | null;
  /** «Riaccendi» più recente dopo il collaudo completo, se c'è. */
  relight: ReleaseRelightBrief | null;
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

/** Ultimo collaudo completo del lavoro di ognuna delle voci date (per id della voce `release`), con l'ultimo «Riaccendi». */
export async function releaseTestsForActions(actionIds: number[], now: Date = new Date()): Promise<Map<number, ReleaseTestBrief>> {
  const out = new Map<number, ReleaseTestBrief>();
  if (actionIds.length === 0) return out;
  const works = await db
    .select({ id: teamWorksTable.id, actionId: teamWorksTable.pendingActionId })
    .from(teamWorksTable)
    .where(inArray(teamWorksTable.pendingActionId, actionIds));
  if (works.length === 0) return out;
  const tests = await db
    .select({
      id: releaseTestsTable.id,
      workId: releaseTestsTable.workId,
      mode: releaseTestsTable.mode,
      status: releaseTestsTable.status,
      outcome: releaseTestsTable.outcome,
      report: releaseTestsTable.report,
      error: releaseTestsTable.error,
      tunnelUrl: releaseTestsTable.tunnelUrl,
      tunnelUntil: releaseTestsTable.tunnelUntil,
    })
    .from(releaseTestsTable)
    .where(inArray(releaseTestsTable.workId, works.map((w) => w.id)))
    .orderBy(desc(releaseTestsTable.id));
  for (const work of works) {
    if (work.actionId === null) continue;
    const full = tests.find((t) => t.workId === work.id && t.mode === "full");
    if (!full) continue;
    const relight = tests.find((t) => t.workId === work.id && t.mode === "relight" && t.id > full.id);
    const live = relight !== undefined && relight.tunnelUrl !== null && relight.tunnelUntil !== null && relight.tunnelUntil.getTime() > now.getTime();
    out.set(work.actionId, {
      id: full.id,
      status: full.status,
      outcome: full.outcome,
      summary: reportSummary(full.report),
      relight: relight
        ? { id: relight.id, status: relight.status, error: relight.error, tunnelUrl: live ? relight.tunnelUrl : null, tunnelUntil: live ? relight.tunnelUntil : null }
        : null,
    });
  }
  return out;
}
