import { describe, expect, it } from "vitest";
import { fakeSourcesFetch, LITELLM_FIXTURE, OPENROUTER_FIXTURE } from "../../../test/fake-sources";
import { fetchLiteLlmSource, fetchOpenRouterSource, LITELLM_PRICES_URL, OPENROUTER_MODELS_URL, SourceError } from "./sources";

const OR_MESSAGE = "fonte OpenRouter non raggiungibile: dati non aggiornati";
const LL_MESSAGE = "fonte LiteLLM non raggiungibile: dati non aggiornati";

function orWith(model: Record<string, unknown>) {
  return fakeSourcesFetch({ openrouter: { data: [{ id: "x/y", ...model }] } });
}
function llWith(entries: Record<string, unknown>) {
  return fakeSourcesFetch({ litellm: entries });
}

describe("fetchOpenRouterSource", () => {
  it("legge le fixture: prezzi per Mtok, data, contesto e strumenti", async () => {
    const entries = await fetchOpenRouterSource(fakeSourcesFetch());
    expect(entries).toHaveLength(OPENROUTER_FIXTURE.data.length);
    const chat = entries.find((e) => e.key === "deepseek/deepseek-chat");
    expect(chat).toEqual({
      source: "openrouter",
      key: "deepseek/deepseek-chat",
      litellmProvider: null,
      name: "DeepSeek: DeepSeek V3",
      releasedAt: new Date(1735084800 * 1000),
      priceInput: 0.27,
      priceOutput: 1.1,
      contextTokens: 131072,
      supportsTools: true,
      deprecationDate: null,
      mode: "chat",
      supportsVision: false,
      supportsReasoning: false,
    });
    expect(entries.find((e) => e.key === "google/gemini-2.0-flash-exp:free")?.supportsTools).toBe(false);
  });

  it("created in secondi Unix → releasedAt; non valido → null", async () => {
    const [ok] = await fetchOpenRouterSource(orWith({ created: 1767225600 }));
    expect(ok?.releasedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    for (const bad of [0, -5, 1.5, "1767225600", null]) {
      const [e] = await fetchOpenRouterSource(orWith({ created: bad }));
      expect(e?.releasedAt).toBeNull();
    }
  });

  it("supported_parameters assente → supportsTools null", async () => {
    const [e] = await fetchOpenRouterSource(orWith({}));
    expect(e?.supportsTools).toBeNull();
    const [t] = await fetchOpenRouterSource(orWith({ supported_parameters: ["tools"] }));
    expect(t?.supportsTools).toBe(true);
  });

  it("prezzo non valido → null, voce presente; id con caratteri di controllo scartato", async () => {
    const f = fakeSourcesFetch({
      openrouter: {
        data: [
          { id: "a/ok", pricing: { prompt: "-1", completion: "boh" } },
          { id: "a/bell\u0007", name: "x" },
          { id: 42 },
          "stringa",
        ],
      },
    });
    const entries = await fetchOpenRouterSource(f);
    expect(entries.map((e) => e.key)).toEqual(["a/ok"]);
    expect(entries[0]?.priceInput).toBeNull();
    expect(entries[0]?.priceOutput).toBeNull();
  });

  it("errori: 302, 500, HTML, forma sbagliata, rete → SourceError a testo fisso senza URL", async () => {
    const failing: typeof fetch = (async () => {
      throw new Error(`connect ECONNREFUSED ${OPENROUTER_MODELS_URL}`);
    }) as typeof fetch;
    const html: typeof fetch = (async () => new Response("<html>no</html>", { status: 200 })) as typeof fetch;
    const cases = [fakeSourcesFetch({ openrouter: 302 }), fakeSourcesFetch({ openrouter: 500 }), html, fakeSourcesFetch({ openrouter: { data: 3 } }), fakeSourcesFetch({ openrouter: [] }), failing];
    for (const f of cases) {
      const err = await fetchOpenRouterSource(f).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect((err as SourceError).source).toBe("openrouter");
      expect((err as SourceError).message).toBe(OR_MESSAGE);
      expect((err as SourceError).message).not.toContain("http");
    }
  });

  it("corpo oltre 20 MB (content-length dichiarato o flusso senza intestazione) → SourceError", async () => {
    const declared: typeof fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } })) as typeof fetch;
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const streamed: typeof fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ >= 21) controller.close();
            else controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    for (const f of [declared, streamed]) {
      await expect(fetchOpenRouterSource(f)).rejects.toMatchObject({ name: "SourceError", message: OR_MESSAGE });
    }
  });

  it("chiama l'indirizzo fisso senza seguire i redirect", async () => {
    let seen: { url: string; redirect?: string } | null = null;
    const spy: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen = { url: String(input), redirect: init?.redirect };
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    await fetchOpenRouterSource(spy);
    expect(seen).toEqual({ url: OPENROUTER_MODELS_URL, redirect: "manual" });
  });
});

describe("fetchLiteLlmSource", () => {
  it("legge le fixture saltando sample_spec", async () => {
    const entries = await fetchLiteLlmSource(fakeSourcesFetch());
    expect(entries.map((e) => e.key).sort()).toEqual(
      Object.keys(LITELLM_FIXTURE).filter((k) => k !== "sample_spec").sort(),
    );
    const v4 = entries.find((e) => e.key === "deepseek/deepseek-v4-pro");
    expect(v4).toEqual({
      source: "litellm",
      key: "deepseek/deepseek-v4-pro",
      litellmProvider: "deepseek",
      name: null,
      releasedAt: null,
      priceInput: 1.45,
      priceOutput: 2.9,
      contextTokens: 1000000,
      supportsTools: true,
      deprecationDate: null,
      mode: "chat",
      supportsVision: null,
      supportsReasoning: null,
    });
  });

  it("prezzo non numerico → null ma voce presente; voci non oggetto saltate", async () => {
    const entries = await fetchLiteLlmSource(
      llWith({ "p/m": { litellm_provider: "p", input_cost_per_token: "x", output_cost_per_token: 0.000001 }, "p/s": "stringa", "p/n": null, "p/a": [] }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.priceInput).toBeNull();
    expect(entries[0]?.priceOutput).toBe(1);
  });

  it("deprecation_date: YYYY-MM-DD → mezzanotte UTC, altro → null", async () => {
    const entries = await fetchLiteLlmSource(
      llWith({
        a: { deprecation_date: "2026-10-16" },
        b: { deprecation_date: "domani" },
        c: { deprecation_date: "2026-02-31" },
        d: { deprecation_date: "2026-10-16T10:00:00Z" },
        e: {},
      }),
    );
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.deprecationDate]));
    expect(byKey["a"]?.toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(byKey["b"]).toBeNull();
    expect(byKey["c"]).toBeNull();
    expect(byKey["d"]).toBeNull();
    expect(byKey["e"]).toBeNull();
  });

  it("supports_function_calling solo booleani; provider ripulito; chiave con controllo scartata", async () => {
    const entries = await fetchLiteLlmSource(
      llWith({
        a: { supports_function_calling: false, litellm_provider: "  groq " },
        b: { supports_function_calling: "true", litellm_provider: 7 },
        "c\u0007": {},
      }),
    );
    expect(entries.map((e) => e.key)).toEqual(["a", "b"]);
    expect(entries[0]).toMatchObject({ supportsTools: false, litellmProvider: "groq" });
    expect(entries[1]).toMatchObject({ supportsTools: null, litellmProvider: null });
  });

  it("errori: 302, 500, HTML, array radice, corpo di 21 MB → SourceError senza URL", async () => {
    const html: typeof fetch = (async () => new Response("<html></html>", { status: 200 })) as typeof fetch;
    const big: typeof fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } })) as typeof fetch;
    const failing: typeof fetch = (async () => {
      throw new Error(`timeout ${LITELLM_PRICES_URL}`);
    }) as typeof fetch;
    const cases = [fakeSourcesFetch({ litellm: 302 }), fakeSourcesFetch({ litellm: 500 }), html, fakeSourcesFetch({ litellm: [] }), big, failing];
    for (const f of cases) {
      const err = await fetchLiteLlmSource(f).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect((err as SourceError).source).toBe("litellm");
      expect((err as SourceError).message).toBe(LL_MESSAGE);
      expect((err as SourceError).message).not.toContain("http");
    }
  });
});

describe("modalità, visione e ragionamento", () => {
  it("OpenRouter: chat; visione da input_modalities, ragionamento da supported_parameters", async () => {
    const [e] = await fetchOpenRouterSource(
      orWith({ architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["reasoning", "tools"] }),
    );
    expect(e).toMatchObject({ mode: "chat", supportsVision: true, supportsReasoning: true });
    const [t] = await fetchOpenRouterSource(orWith({ architecture: { input_modalities: ["text"] }, supported_parameters: ["tools"] }));
    expect(t).toMatchObject({ supportsVision: false, supportsReasoning: false });
    const [n] = await fetchOpenRouterSource(orWith({}));
    expect(n).toMatchObject({ supportsVision: null, supportsReasoning: null });
  });

  it("LiteLLM: mode letto, valore sconosciuto o assente → other; visione e ragionamento booleani", async () => {
    const entries = await fetchLiteLlmSource(
      llWith({
        "a/emb": { litellm_provider: "a", mode: "embedding" },
        "a/new": { litellm_provider: "a", mode: "qualcosa_di_nuovo" },
        "a/none": { litellm_provider: "a" },
        "a/vis": { litellm_provider: "a", mode: "chat", supports_vision: true, supports_reasoning: false },
        "a/bad": { litellm_provider: "a", supports_vision: "si" },
      }),
    );
    const by = (k: string) => entries.find((e) => e.key === k);
    expect(by("a/emb")?.mode).toBe("embedding");
    expect(by("a/new")?.mode).toBe("other");
    expect(by("a/none")?.mode).toBe("other");
    expect(by("a/vis")).toMatchObject({ mode: "chat", supportsVision: true, supportsReasoning: false });
    expect(by("a/bad")).toMatchObject({ supportsVision: null, supportsReasoning: null });
  });
});
