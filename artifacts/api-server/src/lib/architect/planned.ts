import { and, eq, inArray, lt } from "drizzle-orm";
import { db, analysesTable, analysisItemsTable } from "@workspace/db";
import { itemTitle, type PlanChapter } from "../plan-chat/context";
import type { PlannedItem } from "./prompts";

const CHAPTERS: PlanChapter[] = ["endpoint", "completion", "evolution"];

/**
 * Voci create in chat e approvate nelle analisi precedenti dell'app: la rianalisi le riceve come
 * "già pianificate" per non riproporle.
 */
export async function chatPlannedItems(appId: number, beforeAnalysisId: number): Promise<PlannedItem[]> {
  const rows = await db
    .select({ chapter: analysisItemsTable.chapter, payload: analysisItemsTable.payload })
    .from(analysisItemsTable)
    .innerJoin(analysesTable, eq(analysesTable.id, analysisItemsTable.analysisId))
    .where(
      and(
        eq(analysesTable.appId, appId),
        lt(analysesTable.id, beforeAnalysisId),
        eq(analysisItemsTable.origin, "chat"),
        eq(analysisItemsTable.status, "approved"),
        inArray(analysisItemsTable.chapter, CHAPTERS),
      ),
    )
    .orderBy(analysisItemsTable.analysisId, analysisItemsTable.position);
  return rows.map((r) => {
    const chapter = r.chapter as PlanChapter;
    return { chapter, title: itemTitle(chapter, r.payload) };
  });
}
