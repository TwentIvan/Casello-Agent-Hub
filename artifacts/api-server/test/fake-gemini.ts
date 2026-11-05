import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Finta API nativa di Gemini per i test: `GET /models/:name` e `POST /auth_tokens`. I test puntano
 * `GEMINI_NATIVE_BASE` su `base`. Lo stato è modificabile direttamente dai test.
 */
export interface FakeGeminiState {
  /** Nome del modello (senza prefisso) → metodi supportati; assente = 404. */
  models: Record<string, string[]>;
  /** Stato di `/auth_tokens`: 200 = token, altro = errore con quello stato. */
  tokenStatus: number;
  /** Corpi JSON ricevuti da `/auth_tokens`, con la chiave in `apiKey`. */
  tokenRequests: { body: unknown; apiKey: string | undefined }[];
  /** Nome (senza prefisso) di ogni `GET /models/:name`, con la chiave ricevuta. */
  modelRequests: string[];
  /** Chiavi ricevute da `GET /models/:name`, nello stesso ordine di `modelRequests`. */
  modelApiKeys: (string | undefined)[];
  /** Se non null, `GET /models/:name` risponde sempre con questo stato. */
  modelStatus: number | null;
}

export interface FakeGemini {
  /** `http://127.0.0.1:<porta>`: valore per `GEMINI_NATIVE_BASE`. */
  base: string;
  state: FakeGeminiState;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

export async function startFakeGemini(): Promise<FakeGemini> {
  let counter = 0;
  const state: FakeGeminiState = {
    models: {},
    tokenStatus: 200,
    tokenRequests: [],
    modelRequests: [],
    modelApiKeys: [],
    modelStatus: null,
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://fake.gemini");
      const apiKey = req.headers["x-goog-api-key"] as string | undefined;
      const modelMatch = /^\/models\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && modelMatch) {
        const name = decodeURIComponent(modelMatch[1]!);
        state.modelRequests.push(name);
        state.modelApiKeys.push(apiKey);
        if (state.modelStatus !== null) return send(res, state.modelStatus, { error: { message: "fake" } });
        const methods = state.models[name];
        if (!methods) return send(res, 404, { error: { message: "not found" } });
        return send(res, 200, { name: `models/${name}`, supportedGenerationMethods: methods });
      }
      if (req.method === "POST" && url.pathname === "/auth_tokens") {
        state.tokenRequests.push({ body: await readJson(req), apiKey });
        if (state.tokenStatus !== 200) return send(res, state.tokenStatus, { error: { message: "fake" } });
        return send(res, 200, {
          name: `auth_tokens/fake-${++counter}`,
          expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
        });
      }
      send(res, 404, { error: { message: "not found" } });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
