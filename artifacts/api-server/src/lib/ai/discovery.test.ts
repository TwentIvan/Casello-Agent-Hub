import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { allowTestLoopback, FAKE_PROVIDER_ERROR_TEXT, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
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

// Il finto provider ascolta su 127.0.0.1: deroga dei test al divieto del loopback (vedi allowTestLoopback)
let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

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
  // Qui vale il comportamento di produzione: niente deroga dei test per il loopback
  let savedOverride: string | undefined;
  beforeEach(() => {
    savedOverride = process.env["CASELLO_TEST_ALLOW_LOOPBACK"];
    delete process.env["CASELLO_TEST_ALLOW_LOOPBACK"];
  });
  afterEach(() => {
    if (savedOverride === undefined) delete process.env["CASELLO_TEST_ALLOW_LOOPBACK"];
    else process.env["CASELLO_TEST_ALLOW_LOOPBACK"] = savedOverride;
  });

  it("richiede https senza consenso", () => {
    expect(validateBaseUrl("http://x", false)).toBe("indirizzo non consentito");
    expect(validateBaseUrl("https://api.deepseek.com/v1", false)).toBeNull();
    expect(validateBaseUrl("ftp://api.deepseek.com", true)).toBe("indirizzo non consentito");
    expect(validateBaseUrl("non è un url", true)).toBe("indirizzo non consentito");
  });

  it("rifiuta gli host privati senza consenso e li accetta con consenso", () => {
    const privati = [
      "https://10.0.0.1",
      "https://172.16.5.4/v1",
      "https://172.31.255.255",
      "https://192.168.1.1",
      "https://100.64.0.1",
      "https://[fd12::1]",
      "https://[fc00::1]",
      "https://[fd00:ec2::253]",
      "https://[::ffff:192.168.1.1]",
      "https://ollama:11434/v1",
      "https://printer.local",
      "https://db.internal",
    ];
    for (const u of privati) {
      expect(validateBaseUrl(u, false), u).toBe("indirizzo non consentito");
      expect(validateBaseUrl(u, true), u).toBeNull();
    }
    expect(validateBaseUrl("http://10.0.0.1:11434/v1", true)).toBeNull();
    expect(validateBaseUrl("http://192.168.1.10/v1", true)).toBeNull();
    // Indirizzi pubblici vicini ai blocchi privati
    expect(validateBaseUrl("https://172.32.0.1", false)).toBeNull();
    expect(validateBaseUrl("https://11.0.0.1", false)).toBeNull();
    expect(validateBaseUrl("https://[2001:db8::1]", false)).toBeNull();
  });

  it("loopback, link-local, metadati e 0.0.0.0 restano vietati anche con consenso (R6)", () => {
    const sempreVietati = [
      "http://127.0.0.1:8080/v1",
      "https://127.0.0.1",
      "http://127.1.2.3",
      "http://0x7f000001",
      "http://2130706433",
      "http://localhost:11434/v1",
      "http://LOCALHOST.",
      "http://api.localhost",
      "http://api.LOCALHOST",
      "http://[::1]/v1",
      "http://[0:0:0:0:0:0:0:1]",
      "http://169.254.169.254/latest/meta-data",
      "http://169.254.1.1",
      "http://[fe80::1]",
      "http://[febf::1]",
      "http://[fd00:ec2::254]",
      "http://metadata.google.internal",
      "http://0.0.0.0",
      "http://0.1.2.3",
      "http://[::]",
      // IPv4 incorporati in IPv6
      "http://[::ffff:127.0.0.1]",
      "http://[::127.0.0.1]",
      "http://[::ffff:0:7f00:1]",
      "http://[64:ff9b::7f00:1]",
      "http://[::ffff:169.254.169.254]",
      "http://[64:ff9b::a9fe:a9fe]",
      "http://[::ffff:0.0.0.0]",
    ];
    for (const u of sempreVietati) {
      expect(validateBaseUrl(u, true), u).toBe("indirizzo non consentito");
      expect(validateBaseUrl(u, false), u).toBe("indirizzo non consentito");
    }
  });

  it("deroga dei test: CASELLO_TEST_ALLOW_LOOPBACK ammette il loopback con consenso, mai in produzione", () => {
    const savedNodeEnv = process.env["NODE_ENV"];
    try {
      process.env["CASELLO_TEST_ALLOW_LOOPBACK"] = "1";
      process.env["NODE_ENV"] = "test";
      expect(validateBaseUrl("http://127.0.0.1:8080/v1", true)).toBeNull();
      expect(validateBaseUrl("http://localhost:8080/v1", true)).toBeNull();
      expect(validateBaseUrl("http://[::1]:8080/v1", true)).toBeNull();
      // Solo il loopback e solo con consenso: i metadati restano vietati
      expect(validateBaseUrl("http://127.0.0.1:8080/v1", false)).toBe("indirizzo non consentito");
      expect(validateBaseUrl("http://169.254.169.254", true)).toBe("indirizzo non consentito");

      process.env["NODE_ENV"] = "production";
      expect(validateBaseUrl("http://127.0.0.1:8080/v1", true)).toBe("indirizzo non consentito");
      expect(validateBaseUrl("http://localhost:8080/v1", true)).toBe("indirizzo non consentito");
      expect(validateBaseUrl("http://[::1]:8080/v1", true)).toBe("indirizzo non consentito");
    } finally {
      if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = savedNodeEnv;
    }
  });

  it("rifiuta CGNAT, IPv4 dentro IPv6, multicast/broadcast, site-local e host interni senza consenso", () => {
    const vietati = [
      // 100.64.0.0/10 (CGNAT)
      "https://100.64.0.1",
      "https://100.127.255.254",
      // IPv4 incorporato in IPv6: ::/96, ::ffff:0:0/96, 64:ff9b::/96
      "https://[::10.0.0.1]",
      "https://[::ffff:192.168.1.1]",
      "https://[::ffff:100.64.0.1]",
      "https://[64:ff9b::a00:1]",
      // multicast e broadcast
      "https://224.0.0.1",
      "https://239.255.255.250",
      "https://255.255.255.255",
      "https://[ff02::1]",
      // IETF, benchmark e riservati
      "https://192.0.0.8",
      "https://198.18.0.1",
      "https://198.19.255.254",
      "https://240.0.0.1",
      "https://250.1.2.3",
      // SIIT
      "https://[::ffff:0:a00:1]",
      // site-local deprecato
      "https://[fec0::1]",
      // host a etichetta singola e suffissi interni
      "https://intranet",
      "https://ollama:11434/v1",
      "https://db.internal",
      "https://printer.local",
    ];
    for (const u of vietati) {
      expect(validateBaseUrl(u, false), u).toBe("indirizzo non consentito");
      expect(validateBaseUrl(u, true), u).toBeNull();
    }
    // 6to4 e Teredo: rifiutati sempre (incorporano un IPv4 che non si decodifica)
    for (const u of ["https://[2002:808:808::1]", "https://[2002:c0a8:101::1]", "https://[2001:0:4136:e378::1]"]) {
      expect(validateBaseUrl(u, false), u).toBe("indirizzo non consentito");
      expect(validateBaseUrl(u, true), u).toBe("indirizzo non consentito");
    }
    // Vicini pubblici
    expect(validateBaseUrl("https://100.63.255.255", false)).toBeNull();
    expect(validateBaseUrl("https://100.128.0.1", false)).toBeNull();
    expect(validateBaseUrl("https://[64:ff9b::808:808]", false)).toBeNull();
    expect(validateBaseUrl("https://223.255.255.255", false)).toBeNull();
    expect(validateBaseUrl("https://192.0.1.1", false)).toBeNull();
    expect(validateBaseUrl("https://198.20.0.1", false)).toBeNull();
    expect(validateBaseUrl("https://198.17.255.255", false)).toBeNull();
    expect(validateBaseUrl("https://[::ffff:0:808:808]", false)).toBeNull();
    expect(validateBaseUrl("https://[2001:4860::8888]", false)).toBeNull();
    expect(validateBaseUrl("https://api.internal-tools.com/v1", false)).toBeNull();
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

  it("prezzi solo decimali, finiti e sotto 1e6 per Mtok; contesto da stringa intera", async () => {
    fake.models = [
      { id: "hex", pricing: { prompt: "0x10", completion: " 0.000001 " }, context_length: "32768" },
      { id: "enorme", pricing: { prompt: 1, completion: "2" }, context_length: "32768.5" },
      { id: "inf", pricing: { prompt: "Infinity", completion: 1e400 }, context_length: "1e3" },
      { id: "esp", pricing: { prompt: "2.7e-7", completion: "0.00000099" }, context_length: " 4096 " },
    ];
    const models = await discoverModels(account("openrouter"));
    expect(models[0]).toMatchObject({ priceInput: null, priceOutput: 1, contextTokens: 32768 });
    // 1 USD per token = 1e6 per Mtok: fuori scala
    expect(models[1]).toMatchObject({ priceInput: null, priceOutput: null, priceSource: null, contextTokens: null });
    expect(models[2]).toMatchObject({ priceInput: null, priceOutput: null, contextTokens: null });
    expect(models[3]).toMatchObject({ priceInput: 0.27, priceOutput: 0.99, contextTokens: 4096 });
  });

  it("id con caratteri di controllo scartati; id e nomi ripuliti, nome al massimo 256 caratteri", async () => {
    fake.models = [
      { id: "a\nb" },
      { id: "c\u0000" },
      { id: "d\u007f" },
      { id: "  spazi  ", name: `  ${"n".repeat(300)}  ` },
      { id: "spazi" },
    ];
    const models = await discoverModels(account());
    expect(models.map((m) => m.modelId)).toEqual(["spazi"]);
    expect(models[0]!.displayName).toBe("n".repeat(256));
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

  it("altri 4xx → richiesta rifiutata con il solo stato HTTP", async () => {
    for (const status of [400, 405, 413, 422]) {
      fake.status = status;
      const e = await discoverError(account());
      expect(e).toMatchObject({ kind: "rejected", status });
      expect(e.message).toBe(`richiesta rifiutata dal provider (HTTP ${status})`);
    }
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
