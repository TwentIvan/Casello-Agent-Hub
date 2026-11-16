// Dati per le best practice nelle chat di Lucius (solo a interruttore acceso): sintesi dell'App di partenza e fonti curate.

import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { architectureBlockFor } from "../architecture/tool";
import { curatedSourcesBlock } from "./instructions";

/** Sintesi dell'architettura dell'App (se c'è) più le fonti curate dell'utente; vuoto se non c'è nulla. */
export async function bestPracticeData(userId: number, appId: number | null): Promise<string> {
  const [arch, [user]] = await Promise.all([
    architectureBlockFor(appId),
    db.select({ sources: usersTable.luciusSources }).from(usersTable).where(eq(usersTable.id, userId)).limit(1),
  ]);
  return [arch, curatedSourcesBlock(user?.sources ?? [])].filter((b) => b !== "").join("\n\n");
}

/** Argomenti di una tool call come oggetto; illeggibili → oggetto vuoto (lo strumento risponde con il suo errore). */
export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
