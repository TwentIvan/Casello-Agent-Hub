import { sql } from "drizzle-orm";
import { db, providersTable } from "@workspace/db";
import { PROVIDER_REGISTRY, statusForProtocol, type RegistryProvider } from "./provider-registry-data";

/**
 * Allinea la tabella `providers` al registro: upsert di ogni voce con `origin = registry` (anche una riga
 * `discovered` con lo stesso slug, che da qui è riconosciuta). Idempotente: una riga già allineata non
 * viene toccata (nemmeno `updated_at`); `first_seen_at` resta quello della prima comparsa.
 */
export async function ensureProviderRegistry(registry: RegistryProvider[] = PROVIDER_REGISTRY): Promise<void> {
  if (registry.length === 0) return;
  const now = new Date();
  await db
    .insert(providersTable)
    .values(
      registry.map((p) => ({
        slug: p.slug,
        name: p.name,
        protocol: p.protocol,
        defaultBaseUrl: p.defaultBaseUrl,
        sourceKeys: { litellm: p.litellm, openrouterAuthor: p.openrouterAuthor },
        status: statusForProtocol(p.protocol),
        origin: "registry" as const,
        firstSeenAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: providersTable.slug,
      set: {
        name: sql`excluded.name`,
        protocol: sql`excluded.protocol`,
        defaultBaseUrl: sql`excluded.default_base_url`,
        sourceKeys: sql`excluded.source_keys`,
        status: sql`excluded.status`,
        origin: sql`excluded.origin`,
        updatedAt: sql`excluded.updated_at`,
      },
      setWhere: sql`(${providersTable.name}, ${providersTable.protocol}, ${providersTable.defaultBaseUrl}, ${providersTable.sourceKeys}, ${providersTable.status}, ${providersTable.origin})
        IS DISTINCT FROM (excluded.name, excluded.protocol, excluded.default_base_url, excluded.source_keys, excluded.status, excluded.origin)`,
    });
}
