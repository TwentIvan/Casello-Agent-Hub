// Ricetta di collaudo di un'App: salvataggio con versione e lettura

import { desc, eq, sql } from "drizzle-orm";
import { appTestRecipesTable, appsTable, db } from "@workspace/db";
import type { TestRecipe } from "./recipe";

export type RecipeSource = "agent" | "user";

/** Salva la ricetta come versione nuova dell'App; restituisce la versione, null se l'App non esiste. */
export async function saveTestRecipe(appId: number, recipe: TestRecipe, source: RecipeSource): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(appsTable)
      .set({ testRecipe: recipe, testRecipeVersion: sql`${appsTable.testRecipeVersion} + 1` })
      .where(eq(appsTable.id, appId))
      .returning({ version: appsTable.testRecipeVersion });
    if (!row) return null;
    await tx.insert(appTestRecipesTable).values({ appId, version: row.version, recipe, source });
    return row.version;
  });
}

/** Quante versioni dell'elenco si mostrano. */
export const RECIPE_VERSIONS_SHOWN = 20;

/** Ricetta corrente, origine e ultime versioni; null se l'App non esiste. */
export async function readTestRecipe(appId: number) {
  const [app] = await db
    .select({ recipe: appsTable.testRecipe, version: appsTable.testRecipeVersion })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!app) return null;
  const versions = await db
    .select({ version: appTestRecipesTable.version, source: appTestRecipesTable.source, createdAt: appTestRecipesTable.createdAt })
    .from(appTestRecipesTable)
    .where(eq(appTestRecipesTable.appId, appId))
    .orderBy(desc(appTestRecipesTable.version))
    .limit(RECIPE_VERSIONS_SHOWN);
  const current = versions.find((v) => v.version === app.version);
  return { version: app.version, source: current?.source ?? null, recipe: app.recipe ?? null, versions };
}
