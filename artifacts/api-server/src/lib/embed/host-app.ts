// App ospite del pannello incorporato: il token `embed` raggiunge solo l'App il cui `base_url` ha l'origine del suo client.

import type { Request } from "express";
import { db, appsTable, type App } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { HttpError } from "../ai/node-account";

export const HOST_APP_NOT_FOUND = "App non trovata";
/** App di Botcave stessa: quella di default senza `slug` (come `DEFAULT_LEAD_APP_SLUG` di `product-leads.ts`). */
export const DEFAULT_HOST_APP_SLUG = "casello";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Prima App (per id) con `base_url` di quell'origine, altrimenti null. */
export async function embedHostApp(origin: string): Promise<App | null> {
  const apps = await db.select({ id: appsTable.id, baseUrl: appsTable.baseUrl }).from(appsTable).orderBy(asc(appsTable.id));
  const found = apps.find((a) => originOf(a.baseUrl) === origin);
  if (!found) return null;
  const [app] = await db.select().from(appsTable).where(eq(appsTable.id, found.id)).limit(1);
  return app ?? null;
}

/**
 * App su cui lavora la richiesta. Con il pannello incorporato è sempre l'App ospite del client (uno `slug` diverso → 404);
 * altrimenti l'App con quello `slug`, senza `slug` l'App `casello`. `HttpError` 404 «App non trovata» se non esiste.
 */
export async function requireHostApp(req: Request, slug: string | undefined): Promise<App> {
  const auth = req.auth;
  if (auth?.kind === "token" && auth.via === "embed") {
    const app = auth.embedOrigin === undefined ? null : await embedHostApp(auth.embedOrigin);
    if (!app || (slug !== undefined && slug !== app.slug)) throw new HttpError(404, HOST_APP_NOT_FOUND);
    return app;
  }
  const [app] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.slug, slug ?? DEFAULT_HOST_APP_SLUG))
    .limit(1);
  if (!app) throw new HttpError(404, HOST_APP_NOT_FOUND);
  return app;
}
