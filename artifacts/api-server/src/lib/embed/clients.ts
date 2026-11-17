import { db, oauthClientsTable } from "@workspace/db";
import { embedHostApp } from "./host-app";
import { embedAllowedOrigins, embedCallbackUri, embedClientId } from "./origins";

/** Nome da mostrare per un'origine: l'App ospite se esiste, altrimenti l'host. */
export async function embedAppName(origin: string): Promise<string> {
  return (await embedHostApp(origin))?.name ?? new URL(origin).host;
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
