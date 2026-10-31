import { db, providersTable } from "@workspace/db";
import { LEGACY_GATEWAY_PROVIDER } from "../src/lib/ai/providers";

/**
 * La riga del provider storico `system_gateway` non è più in docs/schema-casello.sql (la toglie la migrazione `-post`):
 * i test che simulano il DB di produzione con i resti del vecchio gateway la inseriscono da sé.
 */
export async function ensureLegacyGatewayProvider(): Promise<void> {
  await db
    .insert(providersTable)
    .values({
      slug: LEGACY_GATEWAY_PROVIDER,
      name: "Gateway di Casello",
      protocol: "openai_compatible",
      defaultBaseUrl: null,
      sourceKeys: { litellm: [], openrouterAuthor: null },
      status: "managed",
      origin: "registry",
    })
    .onConflictDoNothing();
}
