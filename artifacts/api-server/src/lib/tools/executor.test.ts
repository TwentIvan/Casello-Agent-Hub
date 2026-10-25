import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "../secrets";
import { buildHttpRequest, executeTool, MAX_RESPONSE_BYTES, ToolError } from "./executor";
import type { AppConnection, CatalogTool, HttpDefinition } from "./types";

const VALID_KEY = "0123456789abcdef".repeat(4);

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

// Server HTTP locale: registra le richieste e risponde secondo il percorso
let server: Server;
let origin: string;
const requests: Recorded[] = [];

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
  const url = req.url ?? "";
  if (url.startsWith("/slow")) return; // non risponde mai
  if (url.startsWith("/stall")) {
    // header e parte del corpo, poi più nulla
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"parziale":');
    return;
  }
  if (url.startsWith("/big")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 120);
    let sent = 0;
    const write = (): void => {
      while (sent < 2 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", write);
          return;
        }
      }
      res.end();
    };
    res.on("error", () => {});
    write();
    return;
  }
  if (url.startsWith("/redirect")) {
    res.writeHead(302, { location: "http://evil.example/" });
    res.end();
    return;
  }
  if (url.startsWith("/missing")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Squadra non trovata" }));
    return;
  }
  if (url.startsWith("/players")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: 1, nome: "Rossi", extra: "x" }]));
    return;
  }
  if (url.startsWith("/text")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("y".repeat(30_000));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handle(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

function conn(overrides: Partial<AppConnection> = {}): AppConnection {
  return {
    baseUrl: "https://app.example.com",
    internalBaseUrl: origin,
    userAuth: { header: "Authorization", scheme: "Bearer" },
    serviceAuth: null,
    serviceSecretEnc: null,
    ...overrides,
  };
}

function tool(
  definition: HttpDefinition,
  paramsSchema: Record<string, unknown> = { type: "object", properties: {} },
  overrides: Partial<CatalogTool> = {},
): CatalogTool {
  return {
    id: 1,
    appId: 1,
    name: "tool_di_prova",
    description: null,
    kind: "http",
    identity: "user",
    requiresConfirmation: false,
    readOnly: true,
    status: "active",
    paramsSchema,
    definition,
    evidence: null,
    needsVerification: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const teamTool = tool(
  { method: "GET", path: "/api/teams/{teamId}", paramLocations: { teamId: "path" } },
  { type: "object", properties: { teamId: { type: "string" } }, required: ["teamId"] },
);

describe("buildHttpRequest", () => {
  it("sostituisce e codifica i parametri di percorso", () => {
    const { url } = buildHttpRequest(conn(), teamTool, { teamId: "../../admin?x=1#y" }, "tok");
    expect(url).toBe(`${origin}/api/teams/..%2F..%2Fadmin%3Fx%3D1%23y`);
  });

  it("rifiuta valori di percorso \".\", \"..\" e vuoti", () => {
    for (const teamId of [".", "..", ""]) {
      expect(() => buildHttpRequest(conn(), teamTool, { teamId }, "tok")).toThrow(ToolError);
    }
  });

  it("rifiuta GET con parametri body (definizione non valida)", () => {
    const t = tool({ method: "GET", path: "/x", paramLocations: { q: "body" } });
    expect(() => buildHttpRequest(conn(), t, { q: "a" }, "tok")).toThrow(/definizione/);
  });

  it("non espone il token nei messaggi di errore", () => {
    try {
      buildHttpRequest(conn(), teamTool, { teamId: "1" }, "tok\r\nX-Evil: segreto-123");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).not.toContain("segreto-123");
    }
  });
});

describe("executeTool", () => {
  let previousKey: string | undefined;
  beforeEach(() => {
    previousKey = process.env["CASELLO_SECRET_KEY"];
    process.env["CASELLO_SECRET_KEY"] = VALID_KEY;
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
    else process.env["CASELLO_SECRET_KEY"] = previousKey;
  });

  it("sostituisce e codifica i parametri di percorso", async () => {
    const r = await executeTool({
      conn: conn(),
      tool: teamTool,
      args: { teamId: "../../admin?x=1#y" },
      userToken: "tok",
    });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/teams/..%2F..%2Fadmin%3Fx%3D1%23y");
    expect(requests[0]!.headers.host).toBe(new URL(origin).host);
  });

  it("un URL completo nel parametro non cambia host", async () => {
    const r = await executeTool({
      conn: conn(),
      tool: teamTool,
      args: { teamId: "http://evil.example/" },
      userToken: "tok",
    });
    expect(r.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/api/teams/http%3A%2F%2Fevil.example%2F");
    expect(requests[0]!.headers.host).toBe(new URL(origin).host);
  });

  it("unisce base con prefisso e slash", async () => {
    const t = tool(
      { method: "GET", path: "/teams/{id}", paramLocations: { id: "path" } },
      { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
    );
    const r = await executeTool({
      conn: conn({ internalBaseUrl: `${origin}/api/` }),
      tool: t,
      args: { id: 7 },
      userToken: "tok",
    });
    expect(r.ok).toBe(true);
    expect(requests[0]!.url).toBe("/api/teams/7");
  });

  it("usa baseUrl quando internalBaseUrl manca", async () => {
    const r = await executeTool({
      conn: conn({ baseUrl: `${origin}/`, internalBaseUrl: null }),
      tool: teamTool,
      args: { teamId: "3" },
      userToken: "tok",
    });
    expect(r.ok).toBe(true);
    expect(requests[0]!.url).toBe("/api/teams/3");
  });

  it("query e body", async () => {
    const t = tool(
      {
        method: "POST",
        path: "/api/teams/{teamId}/players",
        paramLocations: { teamId: "path", ruolo: "query", tag: "query", nome: "body", eta: "body" },
      },
      {
        type: "object",
        properties: {
          teamId: { type: "string" },
          ruolo: { type: "string" },
          tag: { type: "array", items: { type: "string" } },
          nome: { type: "string" },
          eta: { type: "integer" },
        },
        required: ["teamId"],
      },
      { readOnly: false },
    );
    const r = await executeTool({
      conn: conn(),
      tool: t,
      args: { teamId: "5", ruolo: "P&C", tag: ["a", "b"], nome: "Rossi", eta: 30 },
      userToken: "tok",
    });
    expect(r.ok).toBe(true);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    const url = new URL(req.url, origin);
    expect(url.pathname).toBe("/api/teams/5/players");
    expect(url.searchParams.get("ruolo")).toBe("P&C");
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
    expect(req.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(req.body)).toEqual({ nome: "Rossi", eta: 30 });
  });

  it("GET non invia body", async () => {
    await executeTool({ conn: conn(), tool: teamTool, args: { teamId: "1" }, userToken: "tok" });
    expect(requests[0]!.body).toBe("");
    expect(requests[0]!.headers["content-type"]).toBeUndefined();
  });

  it("identità utente", async () => {
    const r = await executeTool({
      conn: conn(),
      tool: teamTool,
      args: { teamId: "1" },
      userToken: "tok-utente",
    });
    expect(r.ok).toBe(true);
    expect(requests[0]!.headers.authorization).toBe("Bearer tok-utente");
  });

  it("identità utente senza token: errore e nessuna richiesta", async () => {
    const r = await executeTool({ conn: conn(), tool: teamTool, args: { teamId: "1" } });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("token utente mancante");
    expect(requests).toHaveLength(0);
  });

  it("identità utente senza configurazione di autenticazione", async () => {
    const r = await executeTool({
      conn: conn({ userAuth: null }),
      tool: teamTool,
      args: { teamId: "1" },
      userToken: "tok",
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("autenticazione utente non configurata");
    expect(requests).toHaveLength(0);
  });

  it("identità servizio", async () => {
    const t = { ...teamTool, identity: "service" as const };
    const r = await executeTool({
      conn: conn({
        userAuth: null,
        serviceAuth: { header: "X-Api-Key", scheme: null },
        serviceSecretEnc: encryptSecret("segreto-di-servizio"),
      }),
      tool: t,
      args: { teamId: "1" },
      userToken: "tok-utente",
    });
    expect(r.ok).toBe(true);
    expect(requests[0]!.headers["x-api-key"]).toBe("segreto-di-servizio");
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it("identità servizio senza segreto: errore e nessuna richiesta", async () => {
    const t = { ...teamTool, identity: "service" as const };
    const r = await executeTool({
      conn: conn({ serviceAuth: { header: "X-Api-Key", scheme: null }, serviceSecretEnc: null }),
      tool: t,
      args: { teamId: "1" },
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("segreto di servizio");
    expect(requests).toHaveLength(0);
  });

  it("argomenti non validi: errore e nessuna richiesta", async () => {
    const r = await executeTool({ conn: conn(), tool: teamTool, args: { teamId: 5 }, userToken: "tok" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("teamId");
    expect(requests).toHaveLength(0);
    const r2 = await executeTool({ conn: conn(), tool: teamTool, args: {}, userToken: "tok" });
    expect(r2.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("timeout", async () => {
    const t = tool({ method: "GET", path: "/slow", paramLocations: {} });
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok", timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("timeout");
  });

  it("risposta troppo grande", async () => {
    const t = tool({ method: "GET", path: "/big", paramLocations: {} });
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain(String(MAX_RESPONSE_BYTES));
  });

  it("redirect", async () => {
    const t = tool({ method: "GET", path: "/redirect", paramLocations: {} });
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
    expect(requests).toHaveLength(1);
  });

  it("responseFields", async () => {
    const t = tool({ method: "GET", path: "/players", paramLocations: {}, responseFields: ["nome"] });
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok" });
    expect(r).toEqual({ ok: true, status: 200, content: '[{"nome":"Rossi"}]' });
  });

  it("risposta testuale troncata", async () => {
    const t = tool({ method: "GET", path: "/text", paramLocations: {} });
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok" });
    expect(r.ok).toBe(true);
    expect(r.content.length).toBeLessThan(20_100);
    expect(r.content).toContain("troncat");
  });

  it("errore HTTP", async () => {
    const t = tool({ method: "GET", path: "/missing", paramLocations: {} });
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.content).toBe("HTTP 404: Squadra non trovata");
  });

  it("tool ui e composite non eseguiti dal server", async () => {
    const ui = await executeTool({
      conn: conn(),
      tool: { ...teamTool, kind: "ui", definition: { action: "apri" } },
      args: {},
    });
    expect(ui.ok).toBe(false);
    expect(ui.content).toContain("eseguito dal client");
    const comp = await executeTool({
      conn: conn(),
      tool: { ...teamTool, kind: "composite", definition: { steps: [{ tool: "a", args: {} }], output: {} } },
      args: {},
    });
    expect(comp.ok).toBe(false);
    expect(comp.content).toContain("tool composti non ancora supportati");
    expect(requests).toHaveLength(0);
  });

  it("errore di rete non lancia e non espone il token", async () => {
    const r = await executeTool({
      conn: conn({ internalBaseUrl: "http://127.0.0.1:1" }),
      tool: teamTool,
      args: { teamId: "1" },
      userToken: "tok-riservato",
    });
    expect(r.ok).toBe(false);
    expect(r.content).not.toContain("tok-riservato");
  });

  it("parametri non previsti dallo schema: errore e nessuna richiesta", async () => {
    const t = tool(
      { method: "POST", path: "/api/teams", paramLocations: { nome: "body" } },
      { type: "object", properties: { nome: { type: "string" } }, required: ["nome"] },
      { readOnly: false },
    );
    const r = await executeTool({
      conn: conn(),
      tool: t,
      args: { nome: "Rossi", role: "admin", ownerId: 1 },
      userToken: "tok",
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("parametri non previsti: role, ownerId");
    expect(requests).toHaveLength(0);
    const ok = await executeTool({ conn: conn(), tool: t, args: { nome: "Rossi" }, userToken: "tok" });
    expect(ok.ok).toBe(true);
    expect(JSON.parse(requests[0]!.body)).toEqual({ nome: "Rossi" });
  });

  it("nomi come constructor non risolvono membri di Object.prototype", async () => {
    const t = tool(
      { method: "GET", path: "/api/x", paramLocations: JSON.parse('{"constructor":"query"}') as HttpDefinition["paramLocations"] },
      { type: "object", properties: { constructor: { type: "string" } } },
    );
    const r = await executeTool({ conn: conn(), tool: t, args: { constructor: "abc" }, userToken: "tok" });
    expect(r.ok).toBe(true);
    expect(new URL(requests[0]!.url, origin).searchParams.get("constructor")).toBe("abc");
    // Dichiarato ma assente: nessun valore ereditato finisce nella query
    const r2 = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok" });
    expect(r2.ok).toBe(true);
    expect(requests[1]!.url).toBe("/api/x");
  });

  it("body con chiave __proto__ dichiarata", async () => {
    const t = tool(
      { method: "POST", path: "/api/x", paramLocations: JSON.parse('{"__proto__":"body"}') as HttpDefinition["paramLocations"] },
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Record<string, unknown>,
      { readOnly: false },
    );
    const args = JSON.parse('{"__proto__":"v"}') as Record<string, unknown>;
    const r = await executeTool({ conn: conn(), tool: t, args, userToken: "tok" });
    expect(r.ok).toBe(true);
    expect(requests[0]!.body).toBe('{"__proto__":"v"}');
  });

  it("valore di percorso non codificabile (surrogato isolato)", async () => {
    const r = await executeTool({ conn: conn(), tool: teamTool, args: { teamId: "a\uD800b" }, userToken: "tok" });
    expect(r).toEqual({ ok: false, content: 'parametro "teamId": valore non codificabile' });
    expect(requests).toHaveLength(0);
  });

  it("timeout durante la lettura del corpo", async () => {
    const t = tool({ method: "GET", path: "/stall", paramLocations: {} });
    const start = Date.now();
    const r = await executeTool({ conn: conn(), tool: t, args: {}, userToken: "tok", timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("timeout");
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("fetchImpl personalizzato riceve redirect manual", async () => {
    let seen: RequestInit | undefined;
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const r = await executeTool({
      conn: conn(),
      tool: teamTool,
      args: { teamId: "1" },
      userToken: "tok",
      fetchImpl: fake,
    });
    expect(r.ok).toBe(true);
    expect(seen?.redirect).toBe("manual");
  });
});
