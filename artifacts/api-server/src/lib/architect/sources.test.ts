import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeOperation,
  fetchGithubTree,
  fetchOpenApi,
  OPENAPI_PATHS,
  SourceError,
} from "./sources";

const TOKEN = "ghp_SECRET_TOKEN_123";

function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = strToU8(v);
  return zipSync(entries);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
let handler: Handler;
let seen: { url: string; auth: string | undefined }[];

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => res.writeHead(404).end();
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("fetchGithubTree", () => {
  it("scarica lo zip, toglie la radice e invia il token", async () => {
    handler = (req, res) => {
      res.writeHead(200).end(Buffer.from(zip({ "repo-abc/src/a.ts": "export const a = 1;" })));
      expect(req.headers["user-agent"]).toBe("casello-architetto");
    };
    const tree = await fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base });
    expect(tree.has("src/a.ts")).toBe(true);
    expect(seen[0]).toEqual({ url: "/repos/o/r/zipball/main", auth: `Bearer ${TOKEN}` });
    await tree.dispose();
  });

  it("senza branch non mette il ref nell'URL", async () => {
    handler = (_req, res) => res.writeHead(200).end(Buffer.from(zip({ "r/a.ts": "x" })));
    await fetchGithubTree({ repo: "o/r", branch: null, token: TOKEN, apiBase: base });
    expect(seen[0]!.url).toBe("/repos/o/r/zipball");
  });

  it("codifica il branch", async () => {
    handler = (_req, res) => res.writeHead(200).end(Buffer.from(zip({ "r/a.ts": "x" })));
    await fetchGithubTree({ repo: "o/r", branch: "feat/x y", token: TOKEN, apiBase: base });
    expect(seen[0]!.url).toBe("/repos/o/r/zipball/feat%2Fx%20y");
  });

  it("segue il redirect senza inoltrare il token a un altro host", async () => {
    const other = createServer((req, res) => {
      seen.push({ url: `other${req.url}`, auth: req.headers.authorization });
      res.writeHead(200).end(Buffer.from(zip({ "r/src/a.ts": "x" })));
    });
    await new Promise<void>((r) => other.listen(0, "localhost", r));
    const otherPort = (other.address() as AddressInfo).port;
    handler = (req, res) => {
      if (req.url!.startsWith("/repos/")) {
        res.writeHead(302, { location: `http://localhost:${otherPort}/signed?sig=abc` }).end();
      }
    };
    try {
      const tree = await fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base });
      expect(tree.has("src/a.ts")).toBe(true);
      expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
      expect(seen[1]).toEqual({ url: "other/signed?sig=abc", auth: undefined });
    } finally {
      other.closeAllConnections();
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("segue un redirect sullo stesso host (token mantenuto)", async () => {
    handler = (req, res) => {
      if (req.url!.startsWith("/repos/")) res.writeHead(302, { location: "/dl" }).end();
      else res.writeHead(200).end(Buffer.from(zip({ "r/src/a.ts": "x" })));
    };
    const tree = await fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base });
    expect(tree.has("src/a.ts")).toBe(true);
    expect(seen[1]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("rifiuta troppi redirect e redirect verso http con apiBase https", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "/loop" }).end();
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base }),
    ).rejects.toThrow(/redirect/);

    const fake = (async () =>
      new Response(null, { status: 302, headers: { location: "http://evil.example/x" } })) as unknown as typeof fetch;
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, fetchImpl: fake }),
    ).rejects.toThrow(/redirect/);
  });

  for (const status of [401, 403]) {
    it(`${status} -> errore senza il token`, async () => {
      handler = (_req, res) => res.writeHead(status).end(`bad ${TOKEN}`);
      const err = await fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base }).catch(
        (e) => e as Error,
      );
      expect(err).toBeInstanceOf(SourceError);
      expect((err as Error).message).toBe("token GitHub non valido o senza accesso al repo");
      expect((err as Error).message).not.toContain(TOKEN);
    });
  }

  it("404 -> non trovato; altri -> errore GitHub", async () => {
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base }),
    ).rejects.toThrow("repo o branch non trovato");
    handler = (_req, res) => res.writeHead(500).end();
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base }),
    ).rejects.toThrow("errore GitHub (500)");
  });

  it("archivio oltre il limite -> errore", async () => {
    handler = (_req, res) => res.writeHead(200).end(Buffer.alloc(5000, 1));
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base, maxZipBytes: 1000 }),
    ).rejects.toThrow("archivio troppo grande");
  });

  it("zip non valido -> SourceError", async () => {
    handler = (_req, res) => res.writeHead(200).end("non uno zip");
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base }),
    ).rejects.toBeInstanceOf(SourceError);
  });

  it("repo non valido: nessuna richiesta", async () => {
    for (const repo of ["../x", "a/b/c", "a", "a/..%2f", "a b/c"]) {
      await expect(
        fetchGithubTree({ repo, branch: null, token: TOKEN, apiBase: base }),
      ).rejects.toBeInstanceOf(SourceError);
    }
    expect(seen).toHaveLength(0);
  });

  it("timeout", async () => {
    handler = () => {};
    await expect(
      fetchGithubTree({ repo: "o/r", branch: "main", token: TOKEN, apiBase: base, timeoutMs: 100 }),
    ).rejects.toThrow(/timeout/);
  });

  it("errore di rete senza token", async () => {
    const fake = (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await fetchGithubTree({ repo: "o/r", branch: null, token: TOKEN, fetchImpl: fake }).catch(
      (e) => e as Error,
    );
    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

const SPEC = {
  openapi: "3.0.0",
  paths: {
    "/users/{id}": {
      get: {
        operationId: "getUser",
        summary: "Dettaglio utente",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
        },
      },
      delete: { responses: { "204": { description: "fatto" } } },
    },
    "/a": { post: { requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
  },
  components: {
    schemas: {
      User: { type: "object", properties: { name: { type: "string" }, boss: { $ref: "#/components/schemas/User" } } },
    },
  },
};

describe("fetchOpenApi", () => {
  it("lo trova al secondo percorso, ordina le operazioni", async () => {
    handler = (req, res) => {
      if (req.url === "/api/openapi.json") res.writeHead(200).end(JSON.stringify(SPEC));
      else res.writeHead(404).end("no");
    };
    const doc = await fetchOpenApi({ openapiUrl: null, baseUrls: [base] });
    expect(doc?.source).toBe(`${base}/api/openapi.json`);
    expect(seen.map((s) => s.url)).toEqual(["/openapi.json", "/api/openapi.json"]);
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
    expect(doc?.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      "POST /a",
      "DELETE /users/{id}",
      "GET /users/{id}",
    ]);
    expect(doc?.operations[2]).toMatchObject({ operationId: "getUser", summary: "Dettaglio utente" });
  });

  it("prova prima openapiUrl e preserva il prefisso della base", async () => {
    handler = (req, res) => {
      if (req.url === "/pre/openapi.json") res.writeHead(200).end(JSON.stringify(SPEC));
      else res.writeHead(404).end();
    };
    const doc = await fetchOpenApi({ openapiUrl: `${base}/custom.json`, baseUrls: [`${base}/pre/`] });
    expect(seen[0]!.url).toBe("/custom.json");
    expect(doc?.source).toBe(`${base}/pre/openapi.json`);
  });

  it("accetta YAML", async () => {
    handler = (req, res) => {
      if (req.url === "/openapi.yaml") {
        res.writeHead(200, { "content-type": "text/html" }).end("openapi: 3.0.0\npaths:\n  /x:\n    get:\n      summary: s\n");
      } else res.writeHead(404).end();
    };
    const doc = await fetchOpenApi({ openapiUrl: null, baseUrls: [base] });
    expect(doc?.operations).toEqual([{ method: "GET", path: "/x", operationId: null, summary: "s" }]);
  });

  it("accetta swagger 2", async () => {
    handler = (_req, res) => res.writeHead(200).end(JSON.stringify({ swagger: "2.0", paths: {} }));
    expect((await fetchOpenApi({ openapiUrl: null, baseUrls: [base] }))?.operations).toEqual([]);
  });

  it("HTML, 404 o JSON senza chiave openapi -> null", async () => {
    handler = (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>ciao</html>");
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base] })).toBeNull();
    handler = (_req, res) => res.writeHead(200).end('{"foo":1}');
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base] })).toBeNull();
    handler = (_req, res) => res.writeHead(404).end();
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base] })).toBeNull();
  });

  it("non segue redirect, ignora schemi non http e risposte troppo grandi", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "/openapi.json" }).end();
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base] })).toBeNull();
    seen.length = 0;
    expect(await fetchOpenApi({ openapiUrl: "file:///etc/passwd", baseUrls: ["ftp://x"] })).toBeNull();
    expect(seen).toHaveLength(0);
    handler = (_req, res) => res.writeHead(200).end(" ".repeat(2_200_000) + JSON.stringify(SPEC));
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base] })).toBeNull();
  });

  it("al massimo 12 candidati", async () => {
    const bases = Array.from({ length: 5 }, (_, i) => `${base}/b${i}`);
    await fetchOpenApi({ openapiUrl: null, baseUrls: bases });
    expect(seen).toHaveLength(12);
    expect(OPENAPI_PATHS).toHaveLength(6);
  });

  it("timeout per candidato", async () => {
    handler = () => {};
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base], timeoutMs: 50 })).toBeNull();
  });

  it("alias bomb YAML -> null", async () => {
    let y = "openapi: 3.0.0\na0: &a0 [x,x]\n";
    for (let i = 1; i < 60; i++) y += `a${i}: &a${i} [*a${i - 1},*a${i - 1}]\n`;
    handler = (_req, res) => res.writeHead(200).end(y);
    expect(await fetchOpenApi({ openapiUrl: null, baseUrls: [base] })).toBeNull();
  });
});

describe("describeOperation", () => {
  const doc = { source: "x", operations: [], raw: SPEC };

  it("include parametri, risposte e $ref risolto con profondità limitata", () => {
    const text = describeOperation(doc, "get", "/users/{id}");
    expect(text).toContain("GET /users/{id}");
    expect(text).toContain("getUser");
    expect(text).toContain('"id"');
    expect(text).toContain('"name"');
    expect(text).toContain("200");
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("corpo della richiesta e operazione mancante", () => {
    expect(describeOperation(doc, "POST", "/a")).toContain("application/json");
    expect(describeOperation(doc, "GET", "/nope")).toMatch(/non trovata/);
  });

  it("ref ciclici e non locali non esplodono", () => {
    const raw = {
      openapi: "3.0.0",
      paths: { "/c": { get: { responses: { "200": { $ref: "#/components/r/A" }, "400": { $ref: "http://x/y" } } } } },
      components: { r: { A: { $ref: "#/components/r/A" } } },
    };
    const text = describeOperation({ source: "x", operations: [], raw }, "GET", "/c");
    expect(text).toContain("200");
    expect(text).not.toContain("http://x/y\"");
  });

  it("tronca a 8000 caratteri", () => {
    const raw = {
      openapi: "3.0.0",
      paths: { "/big": { get: { description: "x".repeat(20_000) } } },
    };
    expect(describeOperation({ source: "x", operations: [], raw }, "GET", "/big").length).toBeLessThanOrEqual(8000);
  });
});
