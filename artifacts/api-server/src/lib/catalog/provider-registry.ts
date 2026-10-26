import { sql } from "drizzle-orm";
import { db, providersTable, type providerProtocolEnum } from "@workspace/db";

/**
 * Registro dei provider AI noti a Casello. Riconoscere un provider nuovo è l'intervento evolutivo: si
 * aggiunge una voce qui e all'avvio `ensureProviderRegistry` la porta nella tabella `providers`.
 *
 * `litellm`: i valori esatti di `litellm_provider` nel listino di LiteLLM che appartengono al provider (ogni
 * nome in un solo provider). `openrouterAuthor`: il prefisso `autore/` di OpenRouter i cui modelli il
 * provider serve direttamente con lo stesso id. Gli indirizzi vengono dalla documentazione ufficiale di
 * ciascun provider; null quando dipende da regione/risorsa o non è certo (lo inserisce l'utente).
 */

export type ProviderProtocol = (typeof providerProtocolEnum.enumValues)[number];

export interface RegistryProvider {
  slug: string;
  name: string;
  protocol: ProviderProtocol;
  defaultBaseUrl: string | null;
  litellm: string[];
  openrouterAuthor: string | null;
}

const oa = (
  slug: string,
  name: string,
  defaultBaseUrl: string | null,
  litellm: string[],
  openrouterAuthor: string | null = null,
): RegistryProvider => ({ slug, name, protocol: "openai_compatible", defaultBaseUrl, litellm, openrouterAuthor });

export const PROVIDER_REGISTRY: RegistryProvider[] = [
  // Provider di oggi: slug e indirizzi invariati (sono i valori salvati negli account)
  oa("deepseek", "DeepSeek", "https://api.deepseek.com/v1", ["deepseek"], "deepseek"),
  oa("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", ["openrouter"]),
  oa("huggingface", "Hugging Face", "https://router.huggingface.co/v1", ["huggingface"]),
  oa("mistral", "Mistral", "https://api.mistral.ai/v1", ["mistral", "codestral", "text-completion-codestral"], "mistralai"),
  oa("groq", "Groq", "https://api.groq.com/openai/v1", ["groq"]),
  oa("together", "Together AI", "https://api.together.xyz/v1", ["together_ai"]),
  oa("gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", ["gemini"], "google"),
  // Pseudo-provider: l'indirizzo lo inserisce l'utente (custom) o arriva da AI_GATEWAY_BASE_URL (system_gateway,
  // mai selezionabile)
  oa("custom", "Personalizzato (compatibile OpenAI)", null, []),
  oa("system_gateway", "Gateway di Casello", null, []),

  // Compatibili OpenAI
  oa("openai", "OpenAI", "https://api.openai.com/v1", ["openai", "text-completion-openai"], "openai"),
  oa("xai", "xAI", "https://api.x.ai/v1", ["xai"], "x-ai"),
  oa("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", ["fireworks_ai", "fireworks_ai-embedding-models"]),
  oa("deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", ["deepinfra"]),
  oa("cerebras", "Cerebras", "https://api.cerebras.ai/v1", ["cerebras"]),
  oa("perplexity", "Perplexity", "https://api.perplexity.ai", ["perplexity"], "perplexity"),
  oa("moonshot", "Moonshot AI", "https://api.moonshot.ai/v1", ["moonshot"], "moonshotai"),
  // Endpoint internazionale (Singapore); quello cinese è dashscope.aliyuncs.com
  oa("dashscope", "Alibaba Cloud (Qwen)", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ["dashscope"], "qwen"),
  oa("zai", "Z.ai", "https://api.z.ai/api/paas/v4", ["zai"], "z-ai"),
  oa("minimax", "MiniMax", "https://api.minimax.io/v1", ["minimax"], "minimax"),
  // Indirizzo non certo (dominio cambiato con il passaggio da AI Studio a Token Factory)
  oa("nebius", "Nebius", null, ["nebius"]),
  oa("sambanova", "SambaNova", "https://api.sambanova.ai/v1", ["sambanova"]),
  // Indirizzo non certo (la documentazione riporta sia /v3/openai sia /openai)
  oa("novita", "Novita AI", null, ["novita"]),
  oa("hyperbolic", "Hyperbolic", "https://api.hyperbolic.xyz/v1", ["hyperbolic"]),
  // Indirizzo non certo (servizio di inferenza di Lambda in dismissione)
  oa("lambda", "Lambda", null, ["lambda_ai"]),
  oa("nscale", "Nscale", "https://inference.api.nscale.com/v1", ["nscale"]),
  oa("ovhcloud", "OVHcloud AI Endpoints", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", ["ovhcloud"]),
  oa("scaleway", "Scaleway", "https://api.scaleway.ai/v1", ["scaleway"]),

  // Protocolli propri, ancora senza esecutore (stato coming)
  {
    slug: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    litellm: ["anthropic"],
    openrouterAuthor: "anthropic",
  },
  // Bedrock e Vertex dipendono dalla regione, Azure dalla risorsa: nessun indirizzo predefinito
  {
    slug: "bedrock",
    name: "Amazon Bedrock",
    protocol: "bedrock",
    defaultBaseUrl: null,
    litellm: ["bedrock", "bedrock_converse", "bedrock_mantle"],
    openrouterAuthor: null,
  },
  {
    slug: "vertex",
    name: "Google Vertex AI",
    protocol: "vertex",
    defaultBaseUrl: null,
    litellm: [
      "vertex_ai",
      "vertex_ai-ai21_models",
      "vertex_ai-anthropic_models",
      "vertex_ai-deepseek_models",
      "vertex_ai-embedding-models",
      "vertex_ai-language-models",
      "vertex_ai-llama_models",
      "vertex_ai-minimax_models",
      "vertex_ai-mistral_models",
      "vertex_ai-moonshot_models",
      "vertex_ai-openai_models",
      "vertex_ai-qwen_models",
      "vertex_ai-text-models",
      "vertex_ai-video-models",
      "vertex_ai-zai_models",
    ],
    openrouterAuthor: null,
  },
  {
    slug: "azure",
    name: "Azure AI",
    protocol: "azure",
    defaultBaseUrl: null,
    litellm: ["azure", "azure_ai", "azure_text"],
    openrouterAuthor: null,
  },
];

/** Stato di un provider dal suo protocollo: gestito solo se Casello ha un esecutore per quel protocollo. */
export function statusForProtocol(protocol: ProviderProtocol): "managed" | "coming" | "unmanaged" {
  if (protocol === "openai_compatible") return "managed";
  if (protocol === "unknown") return "unmanaged";
  return "coming";
}

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
