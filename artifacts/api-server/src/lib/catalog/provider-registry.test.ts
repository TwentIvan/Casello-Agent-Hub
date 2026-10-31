import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, notInArray } from "drizzle-orm";
import { db, modelOffersTable, providersTable } from "@workspace/db";
import { ensureProviderRegistry } from "./provider-registry";
import { PROVIDER_REGISTRY, statusForProtocol, type RegistryProvider } from "./provider-registry-data";
import { LEGACY_GATEWAY_PROVIDER, PROVIDERS } from "../ai/providers";
import { ensureLegacyGatewayProvider } from "../../../test/legacy-gateway";

const bySlug = (slug: string) => PROVIDER_REGISTRY.find((p) => p.slug === slug);
const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();

// I provider di oggi, già presenti in docs/schema-casello.sql; la riga del vecchio gateway (come in produzione
// fino alla migrazione `-post`) non è nello schema: la inserisce `ensureLegacyGatewayProvider` e i test non la cancellano
const TODAY = ["deepseek", "openrouter", "huggingface", "mistral", "groq", "together", "gemini", "custom"];
const KEEP = [...TODAY, LEGACY_GATEWAY_PROVIDER];

describe("PROVIDER_REGISTRY", () => {
  it("slug unici in [a-z0-9-]; il vecchio gateway non c'è più", () => {
    const slugs = PROVIDER_REGISTRY.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(bySlug(LEGACY_GATEWAY_PROVIDER)).toBeUndefined();
  });

  it("contiene i provider di oggi", () => {
    for (const s of TODAY) expect(bySlug(s), s).toBeDefined();
  });

  it("ogni nome LiteLLM e ogni autore OpenRouter compare in un solo provider", () => {
    const litellm = PROVIDER_REGISTRY.flatMap((p) => p.litellm);
    expect(new Set(litellm).size).toBe(litellm.length);
    const authors = PROVIDER_REGISTRY.map((p) => p.openrouterAuthor).filter((a) => a !== null);
    expect(new Set(authors).size).toBe(authors.length);
  });

  it("Bedrock, Vertex e Azure raccolgono tutte le loro varianti LiteLLM", () => {
    expect(sorted(bySlug("bedrock")?.litellm)).toEqual(["bedrock", "bedrock_converse", "bedrock_mantle"]);
    expect(sorted(bySlug("vertex")?.litellm)).toEqual(
      [
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
      ].sort(),
    );
    expect(sorted(bySlug("azure")?.litellm)).toEqual(["azure", "azure_ai", "azure_text"]);
  });

  it("together usa il nome LiteLLM together_ai", () => {
    expect(bySlug("together")?.litellm).toContain("together_ai");
  });

  it("indirizzi predefiniti di oggi invariati", () => {
    expect(bySlug("deepseek")?.defaultBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(bySlug("gemini")?.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(bySlug("custom")?.defaultBaseUrl).toBeNull();
  });

  it("stato dal protocollo: openai_compatible gestito, anthropic/bedrock/vertex/azure in arrivo, unknown non gestito", () => {
    expect(statusForProtocol("openai_compatible")).toBe("managed");
    for (const p of ["anthropic", "bedrock", "vertex", "azure"] as const) expect(statusForProtocol(p)).toBe("coming");
    expect(statusForProtocol("unknown")).toBe("unmanaged");
    expect(bySlug("bedrock")?.protocol).toBe("bedrock");
    expect(bySlug("custom")?.protocol).toBe("openai_compatible");
  });

  it("PROVIDERS è derivato dal registro", () => {
    expect(PROVIDERS.get("together")).toEqual({ label: "Together AI", defaultBaseUrl: "https://api.together.xyz/v1", editableBaseUrl: false });
    expect(PROVIDERS.get("custom")?.editableBaseUrl).toBe(true);
    expect(PROVIDERS.has(LEGACY_GATEWAY_PROVIDER)).toBe(false);
    expect(PROVIDERS.size).toBe(PROVIDER_REGISTRY.length);
  });
});

describe("ensureProviderRegistry", () => {
  afterAll(async () => {
    // Il DB di prova è condiviso: restano solo le righe di oggi (prima le offerte, che fanno riferimento ai provider)
    await db.delete(modelOffersTable).where(notInArray(modelOffersTable.provider, KEEP));
    await db.delete(providersTable).where(notInArray(providersTable.slug, KEEP));
  });

  it("allinea la tabella al registro ed è idempotente; la riga rimasta del vecchio gateway resta com'è", async () => {
    await ensureLegacyGatewayProvider();
    const [legacy] = await db.select().from(providersTable).where(eq(providersTable.slug, LEGACY_GATEWAY_PROVIDER));
    expect(legacy).toBeDefined();
    await ensureProviderRegistry();
    const first = await db.select().from(providersTable).orderBy(providersTable.slug);
    await ensureProviderRegistry();
    const second = await db.select().from(providersTable).orderBy(providersTable.slug);
    expect(second).toEqual(first);
    expect(first.map((r) => r.slug)).toEqual([...PROVIDER_REGISTRY.map((p) => p.slug), LEGACY_GATEWAY_PROVIDER].sort());
    // Né aggiornata né eliminata: la toglie solo la migrazione `-post`
    expect(first.find((r) => r.slug === LEGACY_GATEWAY_PROVIDER)).toEqual(legacy);
    const bedrock = first.find((r) => r.slug === "bedrock")!;
    expect(bedrock).toMatchObject({
      protocol: "bedrock",
      status: "coming",
      origin: "registry",
      defaultBaseUrl: null,
      sourceKeys: { litellm: ["bedrock", "bedrock_converse", "bedrock_mantle"], openrouterAuthor: null },
    });
  });

  it("dopo la migrazione `-post` l'avvio non ricrea il provider del vecchio gateway", async () => {
    try {
      await db.delete(providersTable).where(eq(providersTable.slug, LEGACY_GATEWAY_PROVIDER));
      await ensureProviderRegistry();
      expect(await db.select().from(providersTable).where(eq(providersTable.slug, LEGACY_GATEWAY_PROVIDER))).toEqual([]);
    } finally {
      // DB di prova condiviso: la riga torna com'era per gli altri file
      await ensureLegacyGatewayProvider();
    }
  });

  it("un provider scoperto riconosciuto dal registro diventa registry e prende il protocollo", async () => {
    const firstSeen = new Date("2026-01-01T00:00:00Z");
    await db.insert(providersTable).values({
      slug: "xai-like",
      name: "xai-like",
      protocol: "unknown",
      defaultBaseUrl: null,
      sourceKeys: { litellm: ["xai_like"], openrouterAuthor: null },
      status: "unmanaged",
      origin: "discovered",
      firstSeenAt: firstSeen,
    });
    const entry: RegistryProvider = {
      slug: "xai-like",
      name: "xAI Like",
      protocol: "openai_compatible",
      defaultBaseUrl: "https://api.example.com/v1",
      litellm: ["xai_like"],
      openrouterAuthor: null,
    };
    await ensureProviderRegistry([entry]);
    const [row] = await db.select().from(providersTable).where(inArray(providersTable.slug, ["xai-like"]));
    expect(row).toMatchObject({
      name: "xAI Like",
      protocol: "openai_compatible",
      status: "managed",
      origin: "registry",
      defaultBaseUrl: "https://api.example.com/v1",
      firstSeenAt: firstSeen,
    });
  });
});
