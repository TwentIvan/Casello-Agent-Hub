import { afterAll, describe, expect, it } from "vitest";
import { inArray, notInArray } from "drizzle-orm";
import { db, modelOffersTable, providersTable } from "@workspace/db";
import { ensureProviderRegistry } from "./provider-registry";
import { PROVIDER_REGISTRY, statusForProtocol, type RegistryProvider } from "./provider-registry-data";
import { PROVIDERS } from "../ai/providers";

const bySlug = (slug: string) => PROVIDER_REGISTRY.find((p) => p.slug === slug);
const sorted = (xs: string[] | undefined) => [...(xs ?? [])].sort();

// I provider di oggi, già presenti in docs/schema-casello.sql: i test non li cancellano
const TODAY = ["deepseek", "openrouter", "huggingface", "mistral", "groq", "together", "gemini", "custom", "system_gateway"];

describe("PROVIDER_REGISTRY", () => {
  it("slug unici in [a-z0-9-] (system_gateway e local_agent, con il trattino basso, sono le eccezioni)", () => {
    const slugs = PROVIDER_REGISTRY.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) if (s !== "system_gateway" && s !== "local_agent") expect(s).toMatch(/^[a-z0-9-]+$/);
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
    expect(bySlug("system_gateway")?.defaultBaseUrl).toBeNull();
  });

  it("stato dal protocollo: openai_compatible gestito, anthropic/bedrock/vertex/azure in arrivo, unknown non gestito", () => {
    expect(statusForProtocol("openai_compatible")).toBe("managed");
    for (const p of ["anthropic", "bedrock", "vertex", "azure"] as const) expect(statusForProtocol(p)).toBe("coming");
    expect(statusForProtocol("local_agent")).toBe("managed");
    expect(statusForProtocol("unknown")).toBe("unmanaged");
    expect(bySlug("local_agent")).toMatchObject({ name: "Agente locale", protocol: "local_agent", defaultBaseUrl: null, litellm: [], openrouterAuthor: null });
    expect(bySlug("bedrock")?.protocol).toBe("bedrock");
    expect(bySlug("custom")?.protocol).toBe("openai_compatible");
  });

  it("PROVIDERS è derivato dal registro", () => {
    expect(PROVIDERS.get("together")).toEqual({ label: "Together AI", defaultBaseUrl: "https://api.together.xyz/v1", editableBaseUrl: false });
    expect(PROVIDERS.get("custom")?.editableBaseUrl).toBe(true);
    expect(PROVIDERS.get("system_gateway")?.editableBaseUrl).toBe(false);
    expect(PROVIDERS.size).toBe(PROVIDER_REGISTRY.length);
  });
});

describe("ensureProviderRegistry", () => {
  afterAll(async () => {
    // Il DB di prova è condiviso: restano solo le righe di oggi (prima le offerte, che fanno riferimento ai provider)
    await db.delete(modelOffersTable).where(notInArray(modelOffersTable.provider, TODAY));
    await db.delete(providersTable).where(notInArray(providersTable.slug, TODAY));
  });

  it("allinea la tabella al registro ed è idempotente", async () => {
    await ensureProviderRegistry();
    const first = await db.select().from(providersTable).orderBy(providersTable.slug);
    await ensureProviderRegistry();
    const second = await db.select().from(providersTable).orderBy(providersTable.slug);
    expect(second).toEqual(first);
    expect(first.map((r) => r.slug)).toEqual(PROVIDER_REGISTRY.map((p) => p.slug).sort());
    const bedrock = first.find((r) => r.slug === "bedrock")!;
    expect(bedrock).toMatchObject({
      protocol: "bedrock",
      status: "coming",
      origin: "registry",
      defaultBaseUrl: null,
      sourceKeys: { litellm: ["bedrock", "bedrock_converse", "bedrock_mantle"], openrouterAuthor: null },
    });
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
