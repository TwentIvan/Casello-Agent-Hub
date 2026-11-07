import { db, appsTable, oauthClientsTable } from "@workspace/db";
import { embedAllowedOrigins, embedCallbackUri, embedClientId } from "./origins";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Nome da mostrare per un'origine: l'App con quel `base_url` se esiste (la prima), altrimenti l'host. */
export async function embedAppName(origin: string): Promise<string> {
  const apps = await db.select({ name: appsTable.name, baseUrl: appsTable.baseUrl }).from(appsTable).orderBy(appsTable.id);
  const match = apps.find((a) => originOf(a.baseUrl) === origin);
  return match?.name ?? new URL(origin).host;
}

/** Una riga `oauth_clients` di tipo `embed` per ogni origine ammessa (upsert: nome e indirizzo di ritorno si riallineano). */
export async function ensureEmbedClients(): Promise<void> {
  const redirectUris = [embedCallbackUri()];
  for (const origin of embedAllowedOrigins()) {
    const name = (await embedAppName(origin)).slice(0, 100);
    await db
      .insert(oauthClientsTable)
      .values({ clientId: embedClientId(origin), kind: "embed", name, redirectUris })
      .onConflictDoUpdate({ target: oauthClientsTable.clientId, set: { name, redirectUris } });
  }
}
