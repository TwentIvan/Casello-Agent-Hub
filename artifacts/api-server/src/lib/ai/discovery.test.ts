import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_PROVIDER_ERROR_TEXT, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { discoverModels, PROVIDER_MESSAGES, ProviderError } from "./discovery";
import { PRICE_SEED } from "./price-seed";
import { normalizeBaseUrl, PROVIDERS, validateBaseUrl } from "./providers";

const KEY = "sk-SECRET-KEY-123";

let fake: FakeProvider;

beforeEach(async () => {
  fake = await startFakeProvider();
});
afterEach(async () => {
  await fake.close();
});

function account(provider: "openrouter" | "deepseek" | "custom" = "custom") {
  return { provider, baseUrl: fake.baseUrl, apiKey: KEY, allowPrivateNetwork: true };
}

async function discoverError(acc: Parameters<typeof discoverModels>[0]): Promise<ProviderError> {
  try {
    await discoverModels(acc);
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    const e = err as ProviderError;
    // Nessun messaggio contiene la chiave, l'URL o il corpo della risposta del provider
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain(fake.baseUrl);
    expect(e.message).not.toContain("127.0.0.1");
    expect(e.message).not.toContain(FAKE_PROVIDER_ERROR_TEXT);
    return e;
  }
  throw new Error("atteso un ProviderError");
}

describe("PROVIDERS", () => {
  it("ha i base URL della spec", () => {
    expect(PROVIDERS.deepseek.defaultBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(PROVIDERS.openrouter.defaultBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(PROVIDERS.huggingface.defaultBaseUrl).toBe("https://router.huggingface.co/v1");
    expect(PROVIDERS.mistral.defaultBaseUrl).toBe("https://api.mistral.ai/v1");
    expect(PROVIDERS.groq.defaultBaseUrl).toBe("https://api.groq.com/openai/v1");
    expect(PROVIDERS.together.defaultBaseUrl).toBe("https://api.together.xyz/v1");
    expect(PROVIDERS.custom).toMatchObject({ defaultBaseUrl: null, editableBaseUrl: true });
    expect(PROVIDERS.system_gateway.defaultBaseUrl).toBeNull();
  });
});

describe("validateBaseUrl", () => {
  it("richiede https senza consenso", () => {
    expect(validateBaseUrl("http://x", false)).toBe("indirizzo non consentito");
    expect(validateBaseUrl("https://api.deepseek.com/v1", false)).toBeNull();
    expect(validateBaseUrl("ftp://api.deepseek.com", true)).toBe("indirizzo non consentito");
    expect(validateBaseUrl("non è un url", true)).toBe("indirizzo non consentito");
  });

  it("rifiuta host privati, loopback e localhost senza consenso e li accetta con consenso", () => {
    const privati = [
      "https://10.0.0.1",
      "https://172.16.5.4/v1",
      "https://172.31.255.255",
      "https://192.168.1.1",
      "https://127.0.0.1:8080/v1",
      "https://169.254.169.254",
      "https://0.0.0.0",
      "https://localhost/v1",
      "https://api.localhost",
      "https://LOCALHOST.",
      "https://[::1]/v1",
      "https://[fd12::1]",
      "https://[fe80::1]",
      "https://[::ffff:127.0.0.1]",
      "https://0x7f000001",
    ];
    for (const u of privati) {
      expect(validateBaseUrl(u, false), u).toBe("indirizzo non consentito");
      expect(validateBaseUrl(u, true), u).toBeNull();
    }
    expect(validateBaseUrl("http://10.0.0.1:11434/v1", true)).toBeNull();
    // Indirizzi pubblici vicini ai blocchi privati
    expect(validateBaseUrl("https://172.32.0.1", false)).toBeNull();
    expect(validateBaseUrl("https://11.0.0.1", false)).toBeNull();
    expect(validateBaseUrl("https://[2001:db8::1]", false)).toBeNull();
  });

  it("rifiuta credenziali, query e frammenti nell'indirizzo", () => {
    expect(validateBaseUrl("https://user:pass@api.example.com/v1", false)).toBe("indirizzo non consentito");
    expect(validateBaseUrl("https://api.example.com/v1?x=1", false)).toBe("indirizzo non consentito");
    expect(validateBaseUrl("https://api.example.com/v1#a", false)).toBe("indirizzo non consentito");
  });

  it("normalizeBaseUrl toglie spazi e barre finali", () => {
    expect(normalizeBaseUrl("  https://api.deepseek.com/v1/ ")).toBe("https://api.deepseek.com/v1");
    expect(normalizeBaseUrl("https://api.deepseek.com/v1//")).toBe("https://api.deepseek.com/v1");
  });
});

describe("discoverModels", () => {
  it("OpenRouter con prezzi: USD per token → per milione, contesto e nome", async () => {
    fake.models = [
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek: V3",
        context_length: 163_840,
        pricing: { prompt: "0.00000027", completion: "0.0000011" },
      },
      { id: "openrouter/auto", name: "Auto Router", context_length: 2_000_000, pricing: { prompt: "-1", completion: "-1" } },
    ];
    const models = await discoverModels(account("openrouter"));
    expect(models).toEqual([
      {
        modelId: "deepseek/deepseek-chat",
        displayName: "DeepSeek: V3",
        contextTokens: 163_840,
        priceInput: 0.27,
        priceOutput: 1.1,
        priceSource: "provider",
      },
      {
        modelId: "openrouter/auto",
        displayName: "Auto Router",
        contextTokens: 2_000_000,
        priceInput: null,
        priceOutput: null,
        priceSource: null,
      },
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: "GET", path: "/v1/models", authorization: `Bearer ${KEY}` });
  });

  it("DeepSeek senza prezzi → prezzi dalla tabella seed", async () => {
    fake.models = [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }, { id: "deepseek-nuovo" }];
    const models = await discoverModels(account("deepseek"));
    const seed = PRICE_SEED.find((s) => s.provider === "deepseek" && s.modelId === "deepseek-chat")!;
    expect(models[0]).toEqual({
      modelId: "deepseek-chat",
      displayName: "deepseek-chat",
      contextTokens: null,
      priceInput: seed.input,
      priceOutput: seed.output,
      priceSource: "seed",
    });
    expect(models[1]).toMatchObject({ modelId: "deepseek-reasoner", priceSource: "seed" });
    expect(models[2]).toMatchObject({ modelId: "deepseek-nuovo", priceInput: null, priceOutput: null, priceSource: null });
  });

  it("il seed vale solo per il proprio provider", async () => {
    fake.models = [{ id: "deepseek-chat" }];
    const [m] = await discoverModels(account("custom"));
    expect(m).toMatchObject({ priceInput: null, priceOutput: null, priceSource: null });
  });

  it("prezzi non numerici o negativi → null; contesto non valido → null", async () => {
    fake.models = [
      { id: "a", pricing: { prompt: "abc", completion: "0.000001" }, context_length: "tanti" },
      { id: "b", pricing: { prompt: "-0.000001", completion: -2 }, context_length: -5 },
      { id: "c", pricing: { prompt: 0, completion: "0" }, context_length: 8192.5 },
    ];
    const models = await discoverModels(account("openrouter"));
    expect(models[0]).toMatchObject({ priceInput: null, priceOutput: 1, priceSource: "provider", contextTokens: null });
    expect(models[1]).toMatchObject({ priceInput: null, priceOutput: null, priceSource: null, contextTokens: null });
    expect(models[2]).toMatchObject({ priceInput: 0, priceOutput: 0, priceSource: "provider", contextTokens: null });
  });

  it("scarta voci senza id e duplicati", async () => {
    fake.models = [{ id: "x" }, { id: "" } as never, { id: 5 } as never, { id: "x" }, { id: "y", name: "" }];
    const models = await discoverModels(account());
    expect(models.map((m) => [m.modelId, m.displayName])).toEqual([
      ["x", "x"],
      ["y", "y"],
    ]);
  });

  it("5 000 modelli → al massimo 2 000", async () => {
    fake.models = Array.from({ length: 5000 }, (_, i) => ({ id: `m-${i}` }));
    const models = await discoverModels(account());
    expect(models).toHaveLength(2000);
    expect(models[1999]!.modelId).toBe("m-1999");
  });

  it("risposta oltre 2 MB → provider non raggiungibile", async () => {
    fake.models = Array.from({ length: 3000 }, (_, i) => ({ id: `m-${i}`, description: "x".repeat(1000) }));
    const e = await discoverError(account());
    expect(e.kind).toBe("unreachable");
    expect(e.message).toBe(PROVIDER_MESSAGES.unreachable);
  });

  it("404 su /models → no_models con il messaggio della spec", async () => {
    fake.models = null;
    const e = await discoverError(account());
    expect(e).toMatchObject({ kind: "no_models", status: 404 });
    expect(e.message).toBe("il provider non fornisce l'elenco dei modelli: aggiungili a mano");
  });

  it("401 e 403 → chiave non valida", async () => {
    fake.apiKey = "un'altra chiave";
    let e = await discoverError(account());
    expect(e).toMatchObject({ kind: "auth", status: 401 });
    expect(e.message).toBe("chiave non valida o senza permessi");
    fake.status = 403;
    e = await discoverError(account());
    expect(e).toMatchObject({ kind: "auth", status: 403 });
  });

  it("402 → credito esaurito; 429 → limite di richieste; 500 → non raggiungibile", async () => {
    fake.status = 402;
    let e = await discoverError(account());
    expect(e).toMatchObject({ kind: "credit", status: 402 });
    expect(e.message).toBe("credito del provider esaurito: ricarica il conto o scegli un altro modello");
    fake.status = 429;
    e = await discoverError(account());
    expect(e).toMatchObject({ kind: "rate", status: 429 });
    expect(e.message).toBe("limite di richieste del provider: riprova più tardi");
    fake.status = 500;
    e = await discoverError(account());
    expect(e).toMatchObject({ kind: "unreachable", status: 500 });
    expect(e.message).toBe("provider non raggiungibile");
  });

  it("redirect non seguito", async () => {
    fake.status = 302;
    const e = await discoverError(account());
    expect(e).toMatchObject({ kind: "unreachable", status: 302 });
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/models"]);
  });

  it("errore di rete → non raggiungibile", async () => {
    const baseUrl = fake.baseUrl;
    await fake.close();
    const e = await discoverError({ provider: "custom", baseUrl, apiKey: KEY, allowPrivateNetwork: true });
    expect(e).toMatchObject({ kind: "unreachable", status: null });
    fake = await startFakeProvider();
  });

  it("risposta non JSON → non raggiungibile", async () => {
    const fetchImpl = (async () => new Response("<html>ciao</html>", { status: 200 })) as typeof fetch;
    await expect(discoverModels(account(), fetchImpl)).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("JSON senza elenco → no_models; array nudo accettato", async () => {
    let fetchImpl = (async () => Response.json({ ciao: 1 })) as typeof fetch;
    await expect(discoverModels(account(), fetchImpl)).rejects.toMatchObject({ kind: "no_models" });
    fetchImpl = (async () => Response.json([{ id: "z", display_name: "Zeta" }])) as typeof fetch;
    await expect(discoverModels(account(), fetchImpl)).resolves.toMatchObject([{ modelId: "z", displayName: "Zeta" }]);
  });

  it("base URL privato senza consenso → bad_url, nessuna richiesta", async () => {
    const e = await discoverError({ provider: "custom", baseUrl: fake.baseUrl, apiKey: KEY });
    expect(e).toMatchObject({ kind: "bad_url", status: null });
    expect(e.message).toBe("indirizzo non consentito");
    expect(fake.requests).toHaveLength(0);
  });

  it("senza chiave non manda Authorization", async () => {
    await discoverModels({ ...account(), apiKey: null });
    expect(fake.requests[0]!.authorization).toBeUndefined();
  });
});
