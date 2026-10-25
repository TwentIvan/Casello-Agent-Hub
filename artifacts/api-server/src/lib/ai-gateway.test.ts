import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { aiGateway } from "./ai-gateway";

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_user",
      description: "Legge un utente",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  },
];

describe("aiGateway.chat", () => {
  let server: http.Server;
  let requests: { url: string; auth: string | undefined; body: any }[];
  let reply: any;
  let status: number;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    saved["base"] = process.env["AI_GATEWAY_BASE_URL"];
    saved["key"] = process.env["AI_GATEWAY_API_KEY"];
    requests = [];
    status = 200;
    reply = {
      choices: [{ message: { role: "assistant", content: "ciao" } }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    };
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requests.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw) });
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    process.env["AI_GATEWAY_BASE_URL"] = `http://127.0.0.1:${port}/v1`;
    process.env["AI_GATEWAY_API_KEY"] = "sk-test";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise((r) => server.close(r));
    if (saved["base"] === undefined) delete process.env["AI_GATEWAY_BASE_URL"];
    else process.env["AI_GATEWAY_BASE_URL"] = saved["base"];
    if (saved["key"] === undefined) delete process.env["AI_GATEWAY_API_KEY"];
    else process.env["AI_GATEWAY_API_KEY"] = saved["key"];
  });

  it("invia tools, tool_choice auto, tag e limiti", async () => {
    await aiGateway.chat({
      modelKey: "openrouter/auto",
      messages: [{ role: "user", content: "ciao" }],
      tools: TOOLS,
      maxTokens: 100,
      temperature: 0.2,
      agentId: 7,
      caller: "test",
    });
    expect(requests).toHaveLength(1);
    const { url, auth, body } = requests[0]!;
    expect(url).toBe("/v1/chat/completions");
    expect(auth).toBe("Bearer sk-test");
    expect(body.model).toBe("openrouter/auto");
    expect(body.tools).toEqual(TOOLS);
    expect(body.tool_choice).toBe("auto");
    expect(body.max_completion_tokens).toBe(100);
    expect(body.temperature).toBe(0.2);
    expect(body.metadata.tags).toEqual(["caller:test", "agent:7"]);
  });

  it("senza tool non invia tools né tool_choice", async () => {
    await aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }], tools: [] });
    expect(requests[0]!.body.tools).toBeUndefined();
    expect(requests[0]!.body.tool_choice).toBeUndefined();
  });

  it("restituisce le chiamate ai tool", async () => {
    reply = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_user", arguments: '{"id":"3"}' } },
              { id: "call_2", type: "custom", custom: { name: "altro", input: "x" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    };
    const res = await aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }], tools: TOOLS });
    expect(res.content).toBeNull();
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "get_user", arguments: '{"id":"3"}' }]);
    expect(res.promptTokens).toBe(20);
    expect(res.completionTokens).toBe(8);
  });

  it("restituisce la risposta testuale", async () => {
    const res = await aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }], tools: TOOLS });
    expect(res.content).toBe("ciao");
    expect(res.toolCalls).toEqual([]);
    expect(res.promptTokens).toBe(11);
    expect(res.completionTokens).toBe(5);
  });

  it("rispetta il signal di annullamento", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }], signal: ac.signal }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("chat in modalità proxy: al massimo un nuovo tentativo dopo un errore del gateway", async () => {
    status = 500;
    reply = { error: { message: "errore del gateway" } };
    await expect(aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }] })).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("complete in modalita proxy: corpo, log e risultato invariati", async () => {
    const log = vi.mocked(console.log);
    const res = await aiGateway.complete({
      modelKey: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 50,
      temperature: 0,
      agentId: 3,
      caller: "c",
    });
    expect(requests[0]!.body).toEqual({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_completion_tokens: 50,
      temperature: 0,
      metadata: { tags: ["caller:c", "agent:3"] },
    });
    expect(res).toMatchObject({ content: "ciao", modelKey: "m", promptTokens: 11, completionTokens: 5 });
    expect(log.mock.calls[0]![0]).toMatch(
      /^\[AI-GATEWAY\] caller=c model=m prompt_tokens=11 completion_tokens=5 cached=0 duration=\d+ms$/,
    );
  });

  it("senza proxy rispetta il signal gia annullato", async () => {
    delete process.env["AI_GATEWAY_BASE_URL"];
    const spy = vi.spyOn(aiGateway, "complete");
    const ac = new AbortController();
    ac.abort();
    await expect(
      aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }], signal: ac.signal }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("senza proxy e con tool lancia un errore", async () => {
    delete process.env["AI_GATEWAY_BASE_URL"];
    await expect(
      aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }], tools: TOOLS }),
    ).rejects.toThrow("AI_GATEWAY_BASE_URL");
  });

  it("senza proxy e senza tool ricade su complete", async () => {
    delete process.env["AI_GATEWAY_BASE_URL"];
    const spy = vi
      .spyOn(aiGateway, "complete")
      .mockResolvedValue({ content: "ok", modelKey: "m", promptTokens: 3, completionTokens: 2, durationMs: 1 });
    const res = await aiGateway.chat({ modelKey: "m", messages: [{ role: "user", content: "x" }] });
    expect(spy).toHaveBeenCalledOnce();
    expect(res).toEqual({ content: "ok", toolCalls: [], promptTokens: 3, completionTokens: 2 });
  });

  it("senza proxy rifiuta messaggi non testuali", async () => {
    delete process.env["AI_GATEWAY_BASE_URL"];
    await expect(
      aiGateway.chat({
        modelKey: "m",
        messages: [{ role: "tool", tool_call_id: "c", content: "r" }],
      }),
    ).rejects.toThrow(/messaggi/);
  });
});
