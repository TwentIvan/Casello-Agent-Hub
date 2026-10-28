import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError, APIUserAbortError } from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { eq, inArray } from "drizzle-orm";
import { db, pool, aiAccountsTable, aiModelsTable, providersTable, usersTable } from "@workspace/db";
import { allowTestLoopback, FAKE_PROVIDER_ERROR_TEXT, startFakeProvider, type FakeProvider } from "../../../test/fake-provider";
import { encryptSecret } from "../secrets";
import { logger } from "../logger";
import { ProviderError } from "./discovery";
import { computeCost, executorKindFor, modelChat, ModelAccessError, resolveModel, type ResolvedModel } from "./executor";

// Chiavi di prova: non devono mai comparire in errori o log
const KEY = "sk-ACCOUNT-KEY-0001";
const KEY_2 = "sk-ACCOUNT-KEY-0002";
const GATEWAY_KEY = "sk-GATEWAY-VIRTUAL-KEY";

const ENV_KEYS = ["AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: { name: "get_user", description: "Legge un utente", parameters: { type: "object", properties: {} } },
  },
];

let fake: FakeProvider;
let alice: number;
let bob: number;

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  process.env["CASELLO_SECRET_KEY"] = "c".repeat(64);
  await pool.query("TRUNCATE users, ai_accounts RESTART IDENTITY CASCADE");
  const users = await db
    .insert(usersTable)
    .values([{ email: "alice@example.com" }, { email: "bob@example.com" }])
    .returning({ id: usersTable.id });
  alice = users[0]!.id;
  bob = users[1]!.id;
  fake = await startFakeProvider({ apiKey: KEY });
  process.env["AI_GATEWAY_BASE_URL"] = fake.baseUrl;
  process.env["AI_GATEWAY_API_KEY"] = GATEWAY_KEY;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fake.close();
});

interface AccountOpts {
  userId?: number | null;
  provider?: string;
  baseUrl?: string;
  apiKeyEnc?: string | null;
  allowPrivateNetwork?: boolean;
  priceIn?: string | null;
  priceOut?: string | null;
  contextTokens?: number | null;
}

/** Account + modello; restituisce gli id. */
async function seed(o: AccountOpts = {}): Promise<{ accountId: number; aiModelId: number }> {
  const provider = o.provider ?? "custom";
  const [acc] = await db
    .insert(aiAccountsTable)
    .values({
      userId: o.userId === undefined ? alice : o.userId,
      name: "acc",
      provider,
      baseUrl: o.baseUrl ?? (provider === "system_gateway" ? "env" : fake.baseUrl),
      apiKeyEnc: o.apiKeyEnc === undefined ? (provider === "system_gateway" ? null : encryptSecret(KEY)) : o.apiKeyEnc,
      allowPrivateNetwork: o.allowPrivateNetwork ?? provider === "custom",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({
      accountId: acc!.id,
      modelId: "fake-model",
      displayName: "Fake",
      contextTokens: o.contextTokens ?? null,
      priceInputPerMtok: o.priceIn === undefined ? "0.27" : o.priceIn,
      priceOutputPerMtok: o.priceOut === undefined ? "1.10" : o.priceOut,
    })
    .returning();
  return { accountId: acc!.id, aiModelId: model!.id };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("attesa un'eccezione");
}

/** Il messaggio non contiene chiavi, URL né il corpo d'errore del provider. */
function expectClean(err: unknown): void {
  const text = `${(err as Error).message} ${String((err as Error).stack ?? "")}`;
  for (const secret of [KEY, KEY_2, GATEWAY_KEY, FAKE_PROVIDER_ERROR_TEXT, fake.baseUrl, "127.0.0.1"]) {
    expect((err as Error).message).not.toContain(secret);
  }
  expect(text).not.toContain(FAKE_PROVIDER_ERROR_TEXT);
}

const MESSAGES = [{ role: "user" as const, content: "ciao" }];

// Il finto provider ascolta su 127.0.0.1: deroga dei test al divieto del loopback (vedi allowTestLoopback)
let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});
afterAll(() => restoreLoopback());

describe("computeCost", () => {
  it("calcola il costo in USD per milione di token", () => {
    expect(computeCost(1000, 500, 0.27, 1.1)).toBe(0.00082);
    expect(computeCost(0, 0, 0.27, 1.1)).toBe(0);
  });
  it("è null se manca un prezzo", () => {
    expect(computeCost(1000, 500, null, 1.1)).toBeNull();
    expect(computeCost(1000, 500, 0.27, null)).toBeNull();
  });
  it("arrotonda a 8 decimali", () => {
    expect(computeCost(1, 0, 0.123456789, 0)).toBe(0.00000012);
    expect(computeCost(3, 7, 0.1, 0.2)).toBe(0.0000017);
  });
});

describe("executorKindFor", () => {
  it("openai_compatible e unknown → esecutore compatibile OpenAI; gli altri protocolli → errore fisso", () => {
    expect(executorKindFor("openai_compatible")).toBe("openai_compatible");
    expect(executorKindFor("unknown")).toBe("openai_compatible");
    for (const p of ["anthropic", "bedrock", "vertex", "azure"] as const) {
      expect(() => executorKindFor(p)).toThrow(new ModelAccessError("esecutore non ancora disponibile per questo provider"));
    }
  });
});

describe("resolveModel", () => {
  it("risolve un modello dell'utente con chiave decifrata e prezzi numerici", async () => {
    const { accountId, aiModelId } = await seed();
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: true });
    expect(r).toEqual({
      aiModelId,
      accountId,
      provider: "custom",
      kind: "openai_compatible",
      baseUrl: fake.baseUrl,
      modelId: "fake-model",
      priceInput: 0.27,
      priceOutput: 1.1,
      ownerUserId: alice,
      contextTokens: null,
    });
    expect(r.apiKey).toBe(KEY);
  });

  it("restituisce contextTokens della riga di ai_models, null se assente", async () => {
    const withCtx = await seed({ contextTokens: 128_000 });
    expect((await resolveModel(withCtx.aiModelId, { userId: alice, mustOwn: true })).contextTokens).toBe(128_000);
    const without = await seed({ contextTokens: null });
    expect((await resolveModel(without.aiModelId, { userId: alice, mustOwn: true })).contextTokens).toBeNull();
  });

  it("la chiave non è serializzabile né copiata dallo spread", async () => {
    const { aiModelId } = await seed();
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: true });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(Object.keys(r)).not.toContain("apiKey");
    expect({ ...r }).not.toHaveProperty("apiKey");
  });

  it("mustOwn con userId null rifiuta un account utente", async () => {
    const { aiModelId } = await seed();
    const err = await caught(resolveModel(aiModelId, { userId: null, mustOwn: true }));
    expect(err).toBeInstanceOf(ModelAccessError);
    expect((err as Error).message).toBe("modello non disponibile");
  });

  it("invarianti: system_gateway con proprietario o account utente senza proprietario → non disponibile", async () => {
    const sys = await seed({ userId: alice, provider: "system_gateway" });
    const err = await caught(resolveModel(sys.aiModelId, { userId: alice, mustOwn: false }));
    expect(err).toBeInstanceOf(ModelAccessError);
    expect((err as Error).message).toBe("modello non disponibile");

    await pool.query("TRUNCATE ai_accounts RESTART IDENTITY CASCADE");
    const orphan = await seed({ userId: null, provider: "custom" });
    const err2 = await caught(resolveModel(orphan.aiModelId, { userId: alice, mustOwn: true }));
    expect(err2).toBeInstanceOf(ModelAccessError);
    expect((err2 as Error).message).toBe("modello non disponibile");
  });

  it("rifiuta il modello di un account altrui con mustOwn, lo accetta senza", async () => {
    const { aiModelId } = await seed({ userId: bob });
    const err = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
    expect(err).toBeInstanceOf(ModelAccessError);
    expect((err as Error).message).toBe("modello non disponibile");
    // Chi configura paga: la run usa l'account del modello anche se l'avvia un altro
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: false });
    expect(r.ownerUserId).toBe(bob);
  });

  it("modello inesistente → modello non disponibile", async () => {
    const err = await caught(resolveModel(9999, { userId: alice, mustOwn: false }));
    expect(err).toBeInstanceOf(ModelAccessError);
    expect((err as Error).message).toBe("modello non disponibile");
  });

  it("account di sistema: base URL e chiave dalle env, usabile da tutti", async () => {
    const { aiModelId } = await seed({ userId: null, provider: "system_gateway", priceIn: null, priceOut: null });
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: true });
    expect(r).toMatchObject({
      provider: "system_gateway",
      kind: "openai_compatible",
      baseUrl: fake.baseUrl,
      priceInput: null,
      priceOutput: null,
      ownerUserId: null,
    });
    expect(r.apiKey).toBe(GATEWAY_KEY);
  });

  it("account di sistema senza env → non più disponibile", async () => {
    const { aiModelId } = await seed({ userId: null, provider: "system_gateway" });
    delete process.env["AI_GATEWAY_API_KEY"];
    const err = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
    expect(err).toBeInstanceOf(ModelAccessError);
    expect((err as Error).message).toBe("account di sistema non più disponibile");
    process.env["AI_GATEWAY_API_KEY"] = GATEWAY_KEY;
    delete process.env["AI_GATEWAY_BASE_URL"];
    const err2 = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
    expect((err2 as Error).message).toBe("account di sistema non più disponibile");
  });

  it("rivalida il base URL al momento della chiamata", async () => {
    const { aiModelId } = await seed({ allowPrivateNetwork: false });
    const err = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("bad_url");
    expectClean(err);
  });

  it("chiave non decifrabile → auth", async () => {
    const { aiModelId } = await seed({ apiKeyEnc: "v1:rotta:rotta:rotta" });
    const err = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("auth");
    expectClean(err);
  });
});

describe("resolveModel: esecutore dal protocollo del provider", () => {
  // Provider di prova (fuori dal registro): uno sconosciuto, uno con protocollo proprio senza esecutore
  const SLUGS = ["test-sconosciuto", "test-in-arrivo"];
  const sourceKeys = { litellm: [], openrouterAuthor: null };
  beforeAll(async () => {
    await db.insert(providersTable).values([
      { slug: "test-sconosciuto", name: "Sconosciuto", protocol: "unknown", status: "unmanaged", origin: "discovered", sourceKeys },
      { slug: "test-in-arrivo", name: "In arrivo", protocol: "anthropic", status: "coming", origin: "discovered", sourceKeys },
    ]);
  });
  afterAll(async () => {
    await pool.query("TRUNCATE ai_accounts RESTART IDENTITY CASCADE");
    await db.delete(providersTable).where(inArray(providersTable.slug, SLUGS));
  });

  it("provider non gestito (unknown) → esecutore compatibile OpenAI", async () => {
    const { aiModelId } = await seed({ provider: "test-sconosciuto", allowPrivateNetwork: true });
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: true });
    expect(r).toMatchObject({ provider: "test-sconosciuto", kind: "openai_compatible" });
  });

  it("rete privata salvata: non vale più se il provider diventa gestito → indirizzo non consentito", async () => {
    const { aiModelId } = await seed({ provider: "test-sconosciuto", allowPrivateNetwork: true });
    await db.update(providersTable).set({ status: "managed" }).where(eq(providersTable.slug, "test-sconosciuto"));
    try {
      const err = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).message).toBe("indirizzo non consentito");
    } finally {
      await db.update(providersTable).set({ status: "unmanaged" }).where(eq(providersTable.slug, "test-sconosciuto"));
    }
  });

  it("protocollo senza esecutore → errore fisso", async () => {
    const { aiModelId } = await seed({ provider: "test-in-arrivo", allowPrivateNetwork: true });
    const err = await caught(resolveModel(aiModelId, { userId: alice, mustOwn: true }));
    expect(err).toBeInstanceOf(ModelAccessError);
    expect((err as Error).message).toBe("esecutore non ancora disponibile per questo provider");
    expectClean(err);
  });
});

describe("modelChat", () => {
  async function resolved(o: AccountOpts = {}): Promise<ResolvedModel> {
    const { aiModelId } = await seed(o);
    return resolveModel(aiModelId, { userId: alice, mustOwn: false });
  }

  it("conserva i campi in più delle tool call (firma del ragionamento di Gemini)", async () => {
    const extra = { extra_content: { google: { thought_signature: "firma-123" } } };
    fake.chatReply = {
      content: null,
      toolCalls: [{ id: "call_1", name: "get_user", arguments: "{}", extra }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = await modelChat(await resolved(), { messages: MESSAGES, tools: TOOLS, caller: "test" });
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "get_user", arguments: "{}", extra }]);
  });

  it("manda la chiave dell'account, restituisce tool calls, token e costo", async () => {
    fake.chatReply = {
      content: null,
      toolCalls: [{ id: "call_1", name: "get_user", arguments: '{"id":"7"}' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    };
    const info = vi.spyOn(logger, "info");
    const r = await resolved();
    const out = await modelChat(r, { messages: MESSAGES, tools: TOOLS, maxTokens: 100, temperature: 0.2, caller: "test" });
    expect(out).toEqual({
      content: null,
      toolCalls: [{ id: "call_1", name: "get_user", arguments: '{"id":"7"}' }],
      promptTokens: 1000,
      completionTokens: 500,
      costUsd: 0.00082,
    });
    const req = fake.requests.at(-1)!;
    expect(req.authorization).toBe(`Bearer ${KEY}`);
    const body = req.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: "fake-model", tool_choice: "auto", max_tokens: 100, temperature: 0.2 });
    // Provider diretto: niente estensioni LiteLLM
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("drop_params");
    // Log senza chiave né base URL
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("test");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(fake.baseUrl);
  });

  it("usage assente → token 0 e costo null", async () => {
    fake.chatReply = { content: "ok", toolCalls: [], usage: null };
    const out = await modelChat(await resolved(), { messages: MESSAGES, caller: "test" });
    expect(out).toMatchObject({ content: "ok", promptTokens: 0, completionTokens: 0, costUsd: null });
  });

  it("prezzi mancanti → costo null", async () => {
    const out = await modelChat(await resolved({ priceOut: null }), { messages: MESSAGES, caller: "test" });
    expect(out.costUsd).toBeNull();
    expect(out.promptTokens).toBe(10);
  });

  it("account di sistema: chiave del gateway e metadati LiteLLM", async () => {
    fake.apiKey = GATEWAY_KEY;
    const r = await resolved({ userId: null, provider: "system_gateway" });
    await modelChat(r, { messages: MESSAGES, maxTokens: 50, caller: "run-executor", agentId: 4 });
    const req = fake.requests.at(-1)!;
    expect(req.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(req.body).toMatchObject({
      max_completion_tokens: 50,
      metadata: { tags: ["caller:run-executor", "agent:4"] },
    });
  });

  it("402 → credito esaurito, senza testo del provider", async () => {
    fake.statusFor = { chat: 402 };
    const err = await caught(modelChat(await resolved(), { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("credit");
    expect((err as ProviderError).status).toBe(402);
    expect((err as Error).message).toBe("credito del provider esaurito: ricarica il conto o scegli un altro modello");
    expectClean(err);
  });

  it("401 (chiave errata) → auth; 429 → rate; 500 → unreachable con status", async () => {
    const r = await resolved();
    fake.apiKey = "sk-altra";
    const e401 = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(e401).toMatchObject({ kind: "auth", status: 401, message: "chiave non valida o senza permessi" });
    expectClean(e401);
    fake.apiKey = KEY;
    fake.statusFor = { chat: 429 };
    const e429 = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(e429).toMatchObject({ kind: "rate", status: 429 });
    expectClean(e429);
    fake.statusFor = { chat: 500 };
    const e500 = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(e500).toMatchObject({ kind: "unreachable", status: 500 });
    expectClean(e500);
  });

  it("altri 4xx → rejected con il solo stato HTTP", async () => {
    const r = await resolved();
    for (const status of [400, 404, 422]) {
      fake.statusFor = { chat: status };
      const err = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: "rejected", status });
      expect((err as Error).message).toBe(`richiesta rifiutata dal provider (HTTP ${status})`);
      expectClean(err);
    }
  });

  it("redirect 3xx non seguito → ProviderError con lo stato", async () => {
    fake.statusFor = { chat: 302 };
    const err = await caught(modelChat(await resolved(), { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "unreachable", status: 302 });
    expectClean(err);
    // La destinazione del redirect non viene mai chiesta
    expect(fake.requests.map((q) => q.path)).toEqual(["/v1/chat/completions"]);
  });

  it("risposta 2xx malformata → unreachable con messaggio fisso", async () => {
    const r = await resolved();
    const bodies = [
      JSON.stringify({ id: "x", object: "chat.completion", usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      `<html>${FAKE_PROVIDER_ERROR_TEXT}</html>`,
      `{"choices":[{"message":{"content":"${FAKE_PROVIDER_ERROR_TEXT}`,
      JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ type: "function" }] } }] }),
    ];
    for (const body of bodies) {
      fake.chatRawBody = body;
      const err = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
      expect(err, body).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind: "unreachable", message: "provider non raggiungibile" });
      expectClean(err);
    }
  });

  it("lo stato per rotta del finto provider lascia funzionare /models", async () => {
    fake.statusFor = { chat: 402 };
    const res = await fetch(`${fake.baseUrl}/models`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
  });

  it("provider spento → unreachable", async () => {
    const r = await resolved();
    await fake.close();
    const err = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("unreachable");
    expect((err as ProviderError).status).toBeNull();
    expectClean(err);
    fake = await startFakeProvider();
  });

  it("timeout → errore originale dell'SDK; abort → APIUserAbortError", async () => {
    const r = await resolved();
    fake.delayMs = 500;
    const err = await caught(modelChat(r, { messages: MESSAGES, caller: "test", timeoutMs: 50, maxRetries: 0 }));
    expect(err).toBeInstanceOf(APIConnectionTimeoutError);
    const ctrl = new AbortController();
    const p = modelChat(r, { messages: MESSAGES, caller: "test", signal: ctrl.signal, maxRetries: 0 });
    setTimeout(() => ctrl.abort(), 20);
    const aborted = await caught(p);
    expect(aborted).toBeInstanceOf(APIUserAbortError);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("cambio di chiave dell'account → il client successivo usa la nuova chiave", async () => {
    const { accountId, aiModelId } = await seed();
    await modelChat(await resolveModel(aiModelId, { userId: alice, mustOwn: true }), { messages: MESSAGES, caller: "test" });
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${KEY}`);

    fake.apiKey = KEY_2;
    await db.update(aiAccountsTable).set({ apiKeyEnc: encryptSecret(KEY_2) }).where(eq(aiAccountsTable.id, accountId));
    const r2 = await resolveModel(aiModelId, { userId: alice, mustOwn: true });
    expect(r2.accountId).toBe(accountId);
    await modelChat(r2, { messages: MESSAGES, caller: "test" });
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${KEY_2}`);
  });

  it("account senza chiave → nessun header Authorization", async () => {
    fake.apiKey = null;
    await modelChat(await resolved({ apiKeyEnc: null }), { messages: MESSAGES, caller: "test" });
    expect(fake.requests.at(-1)!.authorization).toBeUndefined();
  });

  it("404 dal provider → modello segnato unavailable; 400 → availability invariata", async () => {
    const { aiModelId } = await seed();
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: false });
    const availability = async () =>
      (await db.select({ a: aiModelsTable.availability }).from(aiModelsTable).where(eq(aiModelsTable.id, aiModelId)))[0]!.a;
    fake.statusFor = { chat: 400 };
    await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(await availability()).toBe("unknown");
    fake.statusFor = { chat: 404 };
    const err = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    // L'errore resta quello di sempre
    expect(err).toMatchObject({ kind: "rejected", status: 404 });
    expect(await availability()).toBe("unavailable");
  });

  it("codice model_not_found (anche con un 400) → unavailable", async () => {
    const { aiModelId } = await seed();
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: false });
    fake.statusFor = { chat: 400 };
    fake.errorCode = "model_not_found";
    await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    const [row] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, aiModelId));
    expect(row!.availability).toBe("unavailable");
  });

  it("errore del DB nel segnare unavailable: solo nel log, il chiamante riceve l'errore del provider", async () => {
    const { aiModelId } = await seed();
    const r = await resolveModel(aiModelId, { userId: alice, mustOwn: false });
    fake.statusFor = { chat: 404 };
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    vi.spyOn(db, "update").mockImplementation(() => {
      throw new Error("db giù");
    });
    const err = await caught(modelChat(r, { messages: MESSAGES, caller: "test", maxRetries: 0 }));
    expect(err).toMatchObject({ kind: "rejected", status: 404 });
    expect(JSON.stringify(error.mock.calls)).not.toContain("db giù");
    expect(error).toHaveBeenCalled();
  });

  it("esecutore local_agent → non ancora disponibile", async () => {
    const r = await resolved();
    await expect(modelChat({ ...r, kind: "local_agent" }, { messages: MESSAGES, caller: "test" })).rejects.toThrow(
      "esecutore non ancora disponibile",
    );
  });
});
