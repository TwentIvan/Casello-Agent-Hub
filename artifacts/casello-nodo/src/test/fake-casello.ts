import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
  /** Istante di arrivo (ms). */
  at: number;
}

export type Handler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/** Casello finto: server HTTP locale con gestori per percorso e registro delle richieste. */
export class FakeCasello {
  readonly requests: RecordedRequest[] = [];
  private handlers = new Map<string, Handler>();
  private server: Server;
  url = "";

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          // corpo non JSON: resta testo
        }
        const rec: RecordedRequest = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body,
          at: Date.now(),
        };
        this.requests.push(rec);
        const handler = this.find(rec);
        if (!handler) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "non trovato" }));
          return;
        }
        Promise.resolve(handler(rec, res)).catch(() => {
          res.statusCode = 500;
          res.end();
        });
      });
    });
  }

  private find(rec: RecordedRequest): Handler | undefined {
    for (const [key, h] of this.handlers) {
      const [method, pattern] = key.split(" ");
      if (method !== rec.method) continue;
      const re = new RegExp(`^${pattern.replace(/:\w+/g, "[^/]+")}$`);
      if (re.test(rec.path)) return h;
    }
    return undefined;
  }

  on(method: string, pattern: string, handler: Handler): this {
    this.handlers.set(`${method} ${pattern}`, handler);
    return this;
  }

  calls(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function json(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
