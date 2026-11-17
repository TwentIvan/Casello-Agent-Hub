import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ResolvedModel } from "../ai/executor";
import { BEST_PRACTICE_MESSAGES } from "./messages";
import { BestPracticeError, searchGemini } from "./search";

let server: http.Server;
let handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let last: { url?: string; headers: http.IncomingHttpHeaders; body: any } | null = null;

const model = { modelId: "models/gemini-2.5-flash", apiKey: "k-secret" } as unknown as ResolvedModel;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      last = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env["GEMINI_NATIVE_BASE"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
});
afterAll(() => {
  delete process.env["GEMINI_NATIVE_BASE"];
  server.closeAllConnections?.();
  server.close();
});
afterEach(() => {
  last = null;
});

const reply = (status: number, json: unknown) => {
  handler = (_r, _b, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(json));
  };
};
const fails = async (msg: string) => {
  const err = await searchGemini(model, "domanda").catch((e) => e);
  expect(err).toBeInstanceOf(BestPracticeError);
  expect((err as Error).message).toBe(msg);
};

describe("searchGemini", () => {
  it("manda la richiesta attesa e legge testo, token, query e fonti", async () => {
    const chunks = [
      ...Array.from({ length: 10 }, (_, i) => ({ web: { uri: `https://g/${i}`, title: `T${i}` } })),
      { web: { uri: "https://g/0", title: "doppione" } },
    ];
    reply(200, {
      candidates: [
        {
          content: { parts: [{ text: "Uno. " }, { text: "Due." }] },
          groundingMetadata: { webSearchQueries: ["a", "b"], groundingChunks: chunks },
        },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
    });
    const r = await searchGemini(model, "come si fa?");
    expect(last!.url).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(last!.headers["x-goog-api-key"]).toBe("k-secret");
    expect(last!.body.tools).toEqual([{ google_search: {} }]);
    expect(last!.body.generationConfig.maxOutputTokens).toBe(1500);
    expect(last!.body.contents[0].parts[0].text).toBe("come si fa?");
    expect(r.answer).toBe("Uno. Due.");
    expect(r.promptTokens).toBe(11);
    expect(r.completionTokens).toBe(22);
    expect(r.searchQueries).toBe(2);
    expect(r.sources).toHaveLength(8);
    expect(r.sources[0]).toEqual({ title: "T0", url: "https://g/0" });
    expect(new Set(r.sources.map((s) => s.url)).size).toBe(8);
  });

  it("somma ragionamento e token degli strumenti", async () => {
    reply(200, {
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 10, toolUsePromptTokenCount: 4, candidatesTokenCount: 20, thoughtsTokenCount: 7 },
    });
    const r = await searchGemini(model, "q");
    expect(r.promptTokens).toBe(14);
    expect(r.completionTokens).toBe(27);
  });

  it("tronca la risposta a 4000 caratteri", async () => {
    reply(200, { candidates: [{ content: { parts: [{ text: "x".repeat(6000) }] } }] });
    expect((await searchGemini(model, "q")).answer).toHaveLength(4000);
  });

  it("senza groundingMetadata: nessuna query né fonte", async () => {
    reply(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const r = await searchGemini(model, "q");
    expect(r.searchQueries).toBe(0);
    expect(r.sources).toEqual([]);
    expect(r.promptTokens).toBe(0);
  });

  it.each([400, 401, 403])("%i → chiave rifiutata", async (s) => {
    reply(s, { error: "x" });
    await fails(BEST_PRACTICE_MESSAGES.keyRejected);
  });
  it("429 → limite di Gemini", async () => {
    reply(429, {});
    await fails(BEST_PRACTICE_MESSAGES.rateLimitedGemini);
  });
  it("500 → non raggiungibile", async () => {
    reply(500, {});
    await fails(BEST_PRACTICE_MESSAGES.unreachable);
  });
  it("timeout → non raggiungibile", async () => {
    handler = () => {}; // non risponde mai
    const orig = AbortSignal.timeout;
    AbortSignal.timeout = () => orig.call(AbortSignal, 50);
    try {
      await fails(BEST_PRACTICE_MESSAGES.unreachable);
    } finally {
      AbortSignal.timeout = orig;
    }
  });
  it("chiede un budget di ragionamento separato", async () => {
    reply(200, { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await searchGemini(model, "domanda");
    expect(last!.body.generationConfig).toMatchObject({ maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 512 } });
  });
  it("testo vuoto con usageMetadata → empty e consumi nell'errore", async () => {
    reply(200, {
      candidates: [{ content: { parts: [] }, groundingMetadata: { webSearchQueries: ["a"] } }],
      usageMetadata: { promptTokenCount: 10, toolUsePromptTokenCount: 5, thoughtsTokenCount: 1500 },
    });
    const err = (await searchGemini(model, "domanda").catch((e) => e)) as BestPracticeError;
    expect(err.message).toBe(BEST_PRACTICE_MESSAGES.empty);
    expect(err.usage).toEqual({ promptTokens: 15, completionTokens: 1500, searchQueries: 1 });
  });
  it("testo vuoto o senza candidati → empty", async () => {
    reply(200, { candidates: [{ content: { parts: [{ text: "  " }] } }] });
    await fails(BEST_PRACTICE_MESSAGES.empty);
    reply(200, {});
    await fails(BEST_PRACTICE_MESSAGES.empty);
  });
});
