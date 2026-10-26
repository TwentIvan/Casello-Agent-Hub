import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Finto provider AI compatibile OpenAI per i test: `GET /v1/models` e `POST /v1/chat/completions`
 * con le forme JSON di OpenAI (quelle che legge l'SDK `openai`). Lo stato è modificabile
 * direttamente dai test; ogni richiesta finisce nel registro `requests`.
 */

/**
 * Il finto provider ascolta su 127.0.0.1, che `validateBaseUrl` rifiuta anche con il consenso alla rete
 * privata: i test che lo usano attivano la deroga `CASELLO_TEST_ALLOW_LOOPBACK` (ignorata con
 * `NODE_ENV=production`). Restituisce la funzione che ripristina il valore precedente.
 */
export function allowTestLoopback(): () => void {
  const previous = process.env["CASELLO_TEST_ALLOW_LOOPBACK"];
  process.env["CASELLO_TEST_ALLOW_LOOPBACK"] = "1";
  return () => {
    if (previous === undefined) delete process.env["CASELLO_TEST_ALLOW_LOOPBACK"];
    else process.env["CASELLO_TEST_ALLOW_LOOPBACK"] = previous;
  };
}

/** Voce grezza di `/models`: i campi extra (name, context_length, pricing…) passano così come sono. */
export interface FakeProviderModel {
  id: string;
  [key: string]: unknown;
}

export interface FakeToolCall {
  id: string;
  name: string;
  /** Argomenti già serializzati in JSON, come li manda il provider. */
  arguments: string;
}

export interface FakeChatReply {
  content: string | null;
  toolCalls: FakeToolCall[];
  /** null = risposta senza `usage` (alcuni provider non la mandano). */
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  /** Default: "tool_calls" se ci sono tool call, altrimenti "stop". */
  finishReason?: string;
}

export interface FakeProviderRequest {
  method: string;
  /** Percorso con query string, es. `/v1/models`. */
  path: string;
  /** Header Authorization così come ricevuto. */
  authorization: string | undefined;
  /** Corpo JSON (o testo se non è JSON), null se assente. */
  body: unknown;
}

export interface FakeProvider {
  /** `http://127.0.0.1:<porta>/v1`: privato, quindi va validato con `allowPrivate = true`. */
  baseUrl: string;
  /** Elenco restituito da `/models`; null = 404 (provider senza elenco dei modelli). */
  models: FakeProviderModel[] | null;
  /** Se non null, ogni richiesta riceve questo stato (con corpo d'errore in stile OpenAI; 3xx con `location`). */
  status: number | null;
  /** Stato forzato per singola rotta (`/models`, `/chat/completions`); prevale su `status`. */
  statusFor: { models?: number; chat?: number };
  /** Se non null, le richieste con un Bearer diverso ricevono 401. */
  apiKey: string | null;
  /** Risposta di `/chat/completions`: oggetto fisso o funzione del corpo della richiesta. */
  chatReply: FakeChatReply | ((body: unknown) => FakeChatReply);
  /** Se non null, `/chat/completions` risponde 200 con questo corpo grezzo (per le risposte malformate). */
  chatRawBody: string | null;
  /** Ritardo prima di ogni risposta (per i timeout). */
  delayMs: number;
  requests: FakeProviderRequest[];
  close(): Promise<void>;
}

/** Testo che il finto provider rimanda negli errori: non deve mai arrivare nei messaggi di Casello. */
export const FAKE_PROVIDER_ERROR_TEXT = "upstream says: invalid key sk-should-not-leak";

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function errorBody(status: number): unknown {
  return { error: { message: `${FAKE_PROVIDER_ERROR_TEXT} (${status})`, type: "fake_error", code: status } };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeProvider(opts: Partial<Omit<FakeProvider, "baseUrl" | "requests" | "close">> = {}): Promise<FakeProvider> {
  let counter = 0;
  const fake: FakeProvider = {
    baseUrl: "",
    models: opts.models === undefined ? [{ id: "fake-model" }] : opts.models,
    status: opts.status ?? null,
    statusFor: opts.statusFor ?? {},
    apiKey: opts.apiKey ?? null,
    chatReply: opts.chatReply ?? { content: "ok", toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    chatRawBody: opts.chatRawBody ?? null,
    delayMs: opts.delayMs ?? 0,
    requests: [],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake.provider");
    const body = await readBody(req);
    const method = req.method ?? "GET";
    fake.requests.push({ method, path: url.pathname + url.search, authorization: req.headers.authorization, body });
    if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));

    const route = url.pathname === "/v1/models" ? "models" : url.pathname === "/v1/chat/completions" ? "chat" : null;
    const forced = (route !== null ? fake.statusFor[route] : undefined) ?? fake.status;
    if (forced !== null) {
      const headers: Record<string, string> = forced >= 300 && forced < 400 ? { location: "/v1/elsewhere" } : {};
      return send(res, forced, errorBody(forced), headers);
    }
    if (fake.apiKey !== null && req.headers.authorization !== `Bearer ${fake.apiKey}`) {
      return send(res, 401, errorBody(401));
    }

    if (method === "GET" && url.pathname === "/v1/models") {
      if (fake.models === null) return send(res, 404, errorBody(404));
      return send(res, 200, {
        object: "list",
        data: fake.models.map((m) => ({ object: "model", created: 1_700_000_000, owned_by: "fake", ...m })),
      });
    }

    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      if (fake.chatRawBody !== null) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(fake.chatRawBody);
        return;
      }
      const reply = typeof fake.chatReply === "function" ? fake.chatReply(body) : fake.chatReply;
      const b = (typeof body === "object" && body !== null ? body : {}) as { model?: unknown };
      const message: Record<string, unknown> = { role: "assistant", content: reply.content };
      if (reply.toolCalls.length) {
        message["tool_calls"] = reply.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        }));
      }
      const response: Record<string, unknown> = {
        id: `chatcmpl-fake-${++counter}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: typeof b.model === "string" ? b.model : "fake-model",
        choices: [
          {
            index: 0,
            message,
            finish_reason: reply.finishReason ?? (reply.toolCalls.length ? "tool_calls" : "stop"),
          },
        ],
      };
      if (reply.usage) {
        response["usage"] = {
          prompt_tokens: reply.usage.prompt_tokens,
          completion_tokens: reply.usage.completion_tokens,
          total_tokens: reply.usage.prompt_tokens + reply.usage.completion_tokens,
        };
      }
      return send(res, 200, response);
    }

    return send(res, 404, errorBody(404));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fake;
}
