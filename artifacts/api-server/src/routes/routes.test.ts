import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, agentsTable, aiAccountsTable, aiModelsTable, runsTable, usersTable, type Run } from "@workspace/db";
import { encryptSecret } from "../lib/secrets";
import { allowTestLoopback } from "../../test/fake-provider";

// Route dell'API su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true) e con
// finto provider compatibile OpenAI (modello degli agenti) e finta app per le run. auth.ts legge l'ambiente all'import: l'app si importa
// dinamicamente dopo aver impostato le variabili.

const SECRET = "segreto-di-servizio-xyz";
const USER_TOKEN = "token-utente-segreto";

let base: string;
let server: http.Server;
let llm: http.Server;
let fakeApp: http.Server;
let fakeAppBase: string;
let llmBase: string;
let llmReplies: unknown[];
let appRequests: { method: string; url: string; auth: string | undefined }[];
let startRun: (runId: number) => Promise<void>;
let setUserToken: (runId: number, token: string) => void;

const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

function toolCallReply(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function rawToolCallReply(name: string, rawArgs: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: rawArgs } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function textReply(text: string) {
  return { choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function getRun(id: number): Promise<Run> {
  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id));
  return run!;
}

async function waitForStatus(id: number, statuses: string[]): Promise<Run> {
  for (let i = 0; i < 200; i++) {
    const run = await getRun(id);
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${id} non arrivata a ${statuses.join("/")}`);
}

const HTTP_TOOL = {
  name: "delete_item",
  description: "Elimina un elemento",
  kind: "http",
  identity: "user",
  level: "L2",
  status: "active",
  paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  definition: { method: "DELETE", path: "/items/{id}", paramLocations: { id: "path" } },
};

async function createApp(name = "Mister", extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/apps", { name, baseUrl: "http://mister.example", internalBaseUrl: fakeAppBase, userAuth: { header: "authorization", scheme: "Bearer" }, ...extra });
  expect(res.status).toBe(201);
  return res.json as { id: number; slug: string; serviceSecretSet: boolean };
}

async function generalAgentOf(appId: number) {
  const res = await api("GET", `/agents?appId=${appId}`);
  return (res.json as { id: number; role: string }[]).find((a) => a.role === "general")!;
}

let stopQueue: () => void;
beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "b".repeat(64);

  llm = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(llmReplies.shift() ?? textReply("(nessuna risposta prevista)")));
    });
  });
  fakeApp = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      appRequests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  llmBase = `http://127.0.0.1:${await listen(llm)}/v1`;
  fakeAppBase = `http://127.0.0.1:${await listen(fakeApp)}/api`;

  const { default: app } = await import("../app");
  ({ startRun } = await import("../lib/run-executor"));
  ({ setUserToken } = await import("../lib/user-tokens"));
  // Lo scheduler delle run gira come in produzione (index.ts lo avvia con startRunQueue).
  stopQueue = (await import("../lib/run-queue")).startRunQueue();
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  stopQueue();
  await close(server);
  await close(llm);
  await close(fakeApp);
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(async () => {
  llmReplies = [];
  appRequests = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

describe("sessione senza login (AUTH_DISABLED)", () => {
  it("GET /auth/me: utente di sviluppo creato al bisogno, senza identità", async () => {
    const res = await api("GET", "/auth/me");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      email: "dev@localhost",
      name: "Sviluppo locale",
      picture: null,
      identities: [],
      githubEnabled: false,
      auth: { kind: "session" },
    });
  });
});

describe("app", () => {
  it("creazione: slug, agente generale in bozza, segreto cifrato e mai restituito", async () => {
    const res = await api("POST", "/apps", { name: "Mister App", baseUrl: "http://mister.example", serviceSecret: SECRET });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ name: "Mister App", slug: "mister-app", serviceSecretSet: true });
    expect(res.json).not.toHaveProperty("serviceSecret");
    expect(res.json).not.toHaveProperty("serviceSecretEnc");
    expect(res.text).not.toContain(SECRET);

    const { rows } = await pool.query("select service_secret_enc from apps where id = $1", [res.json.id]);
    expect(rows[0].service_secret_enc).toMatch(/^v1:/);
    expect(rows[0].service_secret_enc).not.toContain(SECRET);

    const agents = await api("GET", `/agents?appId=${res.json.id}`);
    expect(agents.json).toHaveLength(1);
    expect(agents.json[0]).toMatchObject({ name: "Mister App – generale", role: "general", status: "draft", toolIds: [] });
  });

  it("nome già usato: slug con suffisso '-<id>'", async () => {
    const first = await createApp("Mister");
    const second = await createApp("Mister");
    expect(first.slug).toBe("mister");
    expect(second.slug).toBe(`mister-${second.id}`);
  });

  it("GET restituisce lo slug e nessun campo del segreto", async () => {
    const created = await createApp("Vimini", { serviceSecret: SECRET });
    const res = await api("GET", `/apps/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.json.slug).toBe("vimini");
    expect(res.json.serviceSecretSet).toBe(true);
    expect(res.json).not.toHaveProperty("serviceSecretEnc");
    expect(res.text).not.toContain(SECRET);
    const list = await api("GET", "/apps");
    expect(list.text).not.toContain("serviceSecretEnc");
  });

  it("PATCH: serviceSecret null lo cancella, una stringa lo imposta, assente lo lascia", async () => {
    const created = await createApp("Mister", { serviceSecret: SECRET });
    let res = await api("PATCH", `/apps/${created.id}`, { description: "x" });
    expect(res.json.serviceSecretSet).toBe(true);
    res = await api("PATCH", `/apps/${created.id}`, { serviceSecret: null });
    expect(res.json.serviceSecretSet).toBe(false);
    res = await api("PATCH", `/apps/${created.id}`, { serviceSecret: "nuovo" });
    expect(res.json.serviceSecretSet).toBe(true);
    expect(res.json.slug).toBe("mister");
  });
});

describe("validazione del collegamento all'app", () => {
  const BAD_URLS = [
    "ftp://mister.example",
    "javascript:alert(1)",
    "http://utente:pw@mister.example",
    "http://mister.example/?x=1",
    "http://mister.example/#frammento",
    "non un url",
  ];

  it("mcpUrl: stesse regole di baseUrl, nullable, salvato e restituito", async () => {
    for (const url of ["ftp://example.com/mcp", "http://example.com/mcp?x=1"]) {
      const res = await api("POST", "/apps", { name: "Mister", baseUrl: "http://mister.example", mcpUrl: url });
      expect(res.status, url).toBe(400);
      expect(res.json.error, url).toMatch(/^mcpUrl: indirizzo dell'app non valido/);
    }
    const ok = await api("POST", "/apps", { name: "Mister", baseUrl: "http://mister.example", mcpUrl: "https://mister.example/mcp" });
    expect(ok.status).toBe(201);
    expect(ok.json.mcpUrl).toBe("https://mister.example/mcp");
    const patch = await api("PATCH", `/apps/${ok.json.id}`, { mcpUrl: null });
    expect(patch.status).toBe(200);
    expect(patch.json.mcpUrl).toBeNull();
    expect((await api("PATCH", `/apps/${ok.json.id}`, { mcpUrl: "file:///x" })).status).toBe(400);
  });

  it("POST: baseUrl o internalBaseUrl non validi → 400 con messaggio italiano", async () => {
    for (const url of BAD_URLS) {
      const a = await api("POST", "/apps", { name: "Mister", baseUrl: url });
      expect(a.status, url).toBe(400);
      expect(a.json.error, url).toMatch(/^baseUrl: indirizzo dell'app non valido/);
      const b = await api("POST", "/apps", { name: "Mister", baseUrl: "http://mister.example", internalBaseUrl: url });
      expect(b.status, url).toBe(400);
      expect(b.json.error, url).toMatch(/^internalBaseUrl: indirizzo dell'app non valido/);
    }
    expect((await api("GET", "/apps")).json).toEqual([]);
  });

  it("POST: header di autenticazione non valido o riservato → 400", async () => {
    for (const header of ["X Api Key", "Authorization:", "X-Token\r\nEvil", "Host", "content-type"]) {
      const res = await api("POST", "/apps", { name: "Mister", baseUrl: "http://mister.example", userAuth: { header, scheme: null } });
      expect(res.status, header).toBe(400);
      expect(res.json.error, header).toMatch(/^userAuth\.header: /);
      const svc = await api("POST", "/apps", { name: "Mister", baseUrl: "http://mister.example", serviceAuth: { header, scheme: null } });
      expect(svc.status, header).toBe(400);
      expect(svc.json.error, header).toMatch(/^serviceAuth\.header: /);
    }
  });

  it("PATCH: stesse regole sui campi presenti; valori validi accettati", async () => {
    const app = await createApp();
    expect((await api("PATCH", `/apps/${app.id}`, { internalBaseUrl: "http://mister:3000/api?x=1" })).status).toBe(400);
    expect((await api("PATCH", `/apps/${app.id}`, { baseUrl: "file:///etc/passwd" })).status).toBe(400);
    expect((await api("PATCH", `/apps/${app.id}`, { serviceAuth: { header: "Bad Header", scheme: null } })).status).toBe(400);
    const ok = await api("PATCH", `/apps/${app.id}`, {
      baseUrl: "https://mister.example/app/",
      internalBaseUrl: null,
      userAuth: { header: "X-Api-Key", scheme: null },
      serviceAuth: null,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.baseUrl).toBe("https://mister.example/app/");
  });
});

describe("header fissi dell'app", () => {
  const ORG = "3f1c2b7a-9d4e-4c1a-8b2f-0a1b2c3d4e5f";
  const appBase = { name: "Hub", baseUrl: "http://hub.example", serviceAuth: { header: "X-Service-Key", scheme: null } };

  it("POST e GET: salvati senza spazi ai bordi, sempre presenti nella risposta", async () => {
    const plain = await api("POST", "/apps", { name: "Senza", baseUrl: "http://senza.example" });
    expect(plain.json.extraHeaders).toEqual([]);
    const res = await api("POST", "/apps", {
      ...appBase,
      extraHeaders: [
        { name: " X-Organization-Id ", value: ` ${ORG} ` },
        { name: "X-Organization-Scope", value: "all" },
      ],
    });
    expect(res.status).toBe(201);
    const expected = [
      { name: "X-Organization-Id", value: ORG },
      { name: "X-Organization-Scope", value: "all" },
    ];
    expect(res.json.extraHeaders).toEqual(expected);
    expect((await api("GET", `/apps/${res.json.id}`)).json.extraHeaders).toEqual(expected);
  });

  it("POST: regole violate → 400 con messaggio fisso e nulla salvato", async () => {
    const cases: [unknown[], string][] = [
      [Array.from({ length: 11 }, (_, i) => ({ name: `X-H${i}`, value: "v" })), "extraHeaders: al massimo 10 header fissi"],
      [[{ name: "Host", value: "v" }], "extraHeaders: l'header \"Host\" è riservato"],
      [[{ name: "X-Org", value: "a" }, { name: "x-org", value: "b" }], "extraHeaders: nome di header ripetuto: x-org"],
      [[{ name: "x-service-key", value: "v" }], "extraHeaders: l'header x-service-key è già quello di autenticazione dell'app"],
      [[{ name: "X-Org", value: "a\r\nX-Evil: 1" }], "extraHeaders: valore dell'header X-Org non valido (1-500 caratteri visibili su una riga)"],
      [[{ name: "X-Org", value: "   " }], "extraHeaders: valore dell'header X-Org non valido (1-500 caratteri visibili su una riga)"],
      [[{ name: "X-Org", value: "sk-segreto123" }], "extraHeaders: non salvare credenziali negli header fissi: usa il segreto di servizio"],
    ];
    for (const [extraHeaders, error] of cases) {
      const res = await api("POST", "/apps", { ...appBase, extraHeaders });
      expect(res.status, error).toBe(400);
      expect(res.json.error).toBe(error);
      expect(res.text).not.toContain("segreto123");
    }
    expect((await api("GET", "/apps")).json).toEqual([]);
  });

  it("PATCH: assente invariato, elenco sostituisce, collisione con un nuovo header di autenticazione", async () => {
    const created = await api("POST", "/apps", { ...appBase, extraHeaders: [{ name: "X-Organization-Id", value: ORG }] });
    const id = created.json.id;
    let res = await api("PATCH", `/apps/${id}`, { description: "x" });
    expect(res.json.extraHeaders).toEqual([{ name: "X-Organization-Id", value: ORG }]);
    // Il nuovo header di servizio coincide con un header fisso già salvato
    res = await api("PATCH", `/apps/${id}`, { serviceAuth: { header: "x-organization-id", scheme: null } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("extraHeaders: l'header X-Organization-Id è già quello di autenticazione dell'app");
    res = await api("PATCH", `/apps/${id}`, { userAuth: { header: "X-ORGANIZATION-ID", scheme: null } });
    expect(res.status).toBe(400);
    res = await api("PATCH", `/apps/${id}`, { extraHeaders: [{ name: "x-service-key", value: "v" }] });
    expect(res.status).toBe(400);
    res = await api("PATCH", `/apps/${id}`, { extraHeaders: [{ name: "X-Organization-Scope", value: "all" }] });
    expect(res.status).toBe(200);
    expect(res.json.extraHeaders).toEqual([{ name: "X-Organization-Scope", value: "all" }]);
    res = await api("PATCH", `/apps/${id}`, { extraHeaders: [] });
    expect(res.json.extraHeaders).toEqual([]);
  });
});

describe("catalogo dei tool", () => {
  it("tool con definizione valida → 201", async () => {
    const app = await createApp();
    const res = await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ appId: app.id, name: "delete_item", kind: "http", status: "active" });
    const list = await api("GET", `/apps/${app.id}/tools`);
    expect(list.json).toHaveLength(1);
  });

  it("la risposta ha level e levelOverride e non più i due flag", async () => {
    const app = await createApp();
    const res = await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL);
    expect(res.json).toMatchObject({ level: "L2", levelOverride: null });
    expect(res.json).not.toHaveProperty("readOnly");
    expect(res.json).not.toHaveProperty("requiresConfirmation");
  });

  it("deroga sotto il livello → 400 «il livello può solo essere alzato»; alzare è ammesso", async () => {
    const app = await createApp();
    const tool = (await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL)).json;
    const bad = await api("PATCH", `/apps/${app.id}/tools/${tool.id}`, { levelOverride: "L1" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("il livello può solo essere alzato");
    const create = await api("POST", `/apps/${app.id}/tools`, { ...HTTP_TOOL, name: "altro", levelOverride: "L0" });
    expect(create.status).toBe(400);
    const ok = await api("PATCH", `/apps/${app.id}/tools/${tool.id}`, { levelOverride: "L3" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ level: "L2", levelOverride: "L3" });
  });

  it("il livello dei tool MCP lo dichiara il servizio: dall'API non si imposta", async () => {
    const app = await createApp();
    const mcp = { name: "cerca", kind: "mcp", definition: { mcpName: "cerca" } };
    const bad = await api("POST", `/apps/${app.id}/tools`, { ...mcp, level: "L0" });
    expect(bad.status).toBe(400);
    const ok = await api("POST", `/apps/${app.id}/tools`, mcp);
    expect(ok.status).toBe(201);
    expect(ok.json.kind).toBe("mcp");
    const patch = await api("PATCH", `/apps/${app.id}/tools/${ok.json.id}`, { level: "L0" });
    expect(patch.status).toBe(400);
    expect((await api("POST", `/apps/${app.id}/tools`, { ...mcp, name: "x", definition: {} })).status).toBe(400);
  });

  it("un tool http che diventa mcp perde il livello scelto a mano: L2 e nessuna deroga", async () => {
    const app = await createApp();
    const tool = (await api("POST", `/apps/${app.id}/tools`, { ...HTTP_TOOL, level: "L0", levelOverride: "L1" })).json;
    expect(tool).toMatchObject({ level: "L0", levelOverride: "L1" });
    const res = await api("PATCH", `/apps/${app.id}/tools/${tool.id}`, { kind: "mcp", definition: { mcpName: tool.name } });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ kind: "mcp", level: "L2", levelOverride: null });
    // Una deroga inviata insieme al cambio si confronta con L2
    const http = (await api("POST", `/apps/${app.id}/tools`, { ...HTTP_TOOL, name: "altro", level: "L0" })).json;
    const low = await api("PATCH", `/apps/${app.id}/tools/${http.id}`, { kind: "mcp", definition: { mcpName: "altro" }, levelOverride: "L1" });
    expect(low.status).toBe(400);
  });

  it("segnaposto {teamId} non nello schema → 400", async () => {
    const app = await createApp();
    const res = await api("POST", `/apps/${app.id}/tools`, {
      ...HTTP_TOOL,
      definition: { method: "GET", path: "/teams/{teamId}", paramLocations: {} },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("teamId");
  });

  it("nome duplicato nell'app → 409", async () => {
    const app = await createApp();
    expect((await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL)).status).toBe(201);
    const res = await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("Esiste già uno strumento con questo nome nell'app");
  });

  it("nome non valido → 400", async () => {
    const app = await createApp();
    const res = await api("POST", `/apps/${app.id}/tools`, { ...HTTP_TOOL, name: "elimina elemento" });
    expect(res.status).toBe(400);
  });

  it("PATCH valida la definizione risultante; DELETE → 204", async () => {
    const app = await createApp();
    const tool = (await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL)).json;
    const bad = await api("PATCH", `/apps/${app.id}/tools/${tool.id}`, {
      definition: { method: "DELETE", path: "/items/{other}", paramLocations: { id: "path" } },
    });
    expect(bad.status).toBe(400);
    const ok = await api("PATCH", `/apps/${app.id}/tools/${tool.id}`, { status: "disabled" });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("disabled");
    expect((await api("DELETE", `/apps/${app.id}/tools/${tool.id}`)).status).toBe(204);
    expect((await api("DELETE", `/apps/${app.id}/tools/${tool.id}`)).status).toBe(404);
  });
});

describe("agenti", () => {
  it("DELETE dell'agente generale → 409", async () => {
    const app = await createApp();
    const general = await generalAgentOf(app.id);
    const res = await api("DELETE", `/agents/${general.id}`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("L'agente generale non si può eliminare");
  });

  it("POST /agents crea sempre un agente di area; PUT dei tool: solo tool della stessa app", async () => {
    const app = await createApp("Mister");
    const other = await createApp("ReMove");
    const mine = (await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL)).json;
    const foreign = (await api("POST", `/apps/${other.id}/tools`, HTTP_TOOL)).json;

    const created = await api("POST", "/agents", { appId: app.id, name: "Rosa", role: "general" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ role: "area", toolIds: [] });

    const bad = await api("PUT", `/agents/${created.json.id}/tools`, { toolIds: [mine.id, foreign.id] });
    expect(bad.status).toBe(400);

    const ok = await api("PUT", `/agents/${created.json.id}/tools`, { toolIds: [mine.id] });
    expect(ok.status).toBe(200);
    expect(ok.json.toolIds).toEqual([mine.id]);
    expect((await api("GET", `/agents/${created.json.id}`)).json.toolIds).toEqual([mine.id]);

    expect((await api("PUT", `/agents/${created.json.id}/tools`, { toolIds: [] })).json.toolIds).toEqual([]);
    expect((await api("DELETE", `/agents/${created.json.id}`)).status).toBe(204);
  });

  it("agente generale: PUT dei tool → 400, toolIds = tool attivi dell'app", async () => {
    const app = await createApp();
    const active = (await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL)).json;
    await api("POST", `/apps/${app.id}/tools`, { ...HTTP_TOOL, name: "draft_tool", status: "draft" });
    const general = await generalAgentOf(app.id);
    expect((await api("PUT", `/agents/${general.id}/tools`, { toolIds: [active.id] })).status).toBe(400);
    expect((await api("GET", `/agents/${general.id}`)).json.toolIds).toEqual([active.id]);
  });
});

describe("errori di richiesta", () => {
  it("tool senza kind → 400 JSON con il percorso del campo", async () => {
    const app = await createApp();
    const { kind: _kind, ...withoutKind } = HTTP_TOOL;
    const res = await api("POST", `/apps/${app.id}/tools`, withoutKind);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/^richiesta non valida: kind: /);
  });

  it("POST /runs/:id/resume non esiste più → 404", async () => {
    // Route sconosciuta: risponde il 404 predefinito di Express (non JSON)
    const res = await fetch(`${base}/api/runs/1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(404);
  });

  it(":id non numerico → 400 JSON", async () => {
    const res = await api("GET", "/apps/abc");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("id");
  });

  it("JSON malformato → 400 JSON", async () => {
    const res = await fetch(`${base}/api/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: "{non json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("JSON");
  });

  it("errore inatteso (Postgres rifiuta il byte NUL) → 500 JSON generico", async () => {
    const res = await api("POST", "/apps", { name: "Mis\u0000ter", baseUrl: "http://x" });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "Errore interno" });
  });

  it("POST /agents con app inesistente → 404", async () => {
    const res = await api("POST", "/agents", { appId: 9999, name: "Rosa" });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("App non trovata");
  });

  it("creazioni concorrenti con lo stesso nome: tutte 201, slug distinti", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => api("POST", "/apps", { name: "Mister", baseUrl: "http://mister.example" })),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.json.slug)).size).toBe(4);
  });
});

describe("paginazione delle run", () => {
  async function seedRuns(count: number, agentId: number): Promise<number[]> {
    const rows = await db
      .insert(runsTable)
      .values(Array.from({ length: count }, (_, i) => ({ agentId, input: `r${i}` })))
      .returning({ id: runsTable.id });
    return rows.map((r) => r.id).sort((a, b) => a - b);
  }

  async function seedAgent(name: string) {
    const app = await createApp(name);
    return (await generalAgentOf(app.id)).id;
  }

  it("senza parametri restituisce al massimo 50 run, dalla più recente (id decrescente)", async () => {
    const ids = await seedRuns(55, await seedAgent("Mister"));
    const res = await api("GET", "/runs");
    expect(res.status).toBe(200);
    expect(res.json.map((r: { id: number }) => r.id)).toEqual(ids.slice(-50).reverse());
  });

  it("limit=2 restituisce le 2 più recenti per id", async () => {
    const ids = await seedRuns(5, await seedAgent("Mister"));
    const res = await api("GET", "/runs?limit=2");
    expect(res.json.map((r: { id: number }) => r.id)).toEqual([ids[4], ids[3]]);
  });

  it("before=<id> restituisce solo run più vecchie", async () => {
    const ids = await seedRuns(5, await seedAgent("Mister"));
    const res = await api("GET", `/runs?before=${ids[3]}&limit=10`);
    expect(res.json.map((r: { id: number }) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("si combina con il filtro agentId", async () => {
    const a = await seedAgent("Mister");
    const b = await seedAgent("Vimini");
    const idsA = await seedRuns(3, a);
    await seedRuns(2, b);
    const res = await api("GET", `/runs?agentId=${a}&limit=2`);
    expect(res.json.map((r: { id: number }) => r.id)).toEqual([idsA[2], idsA[1]]);
    const older = await api("GET", `/runs?agentId=${a}&before=${idsA[1]}`);
    expect(older.json.map((r: { id: number }) => r.id)).toEqual([idsA[0]]);
  });

  it("limit fuori intervallo o before non valido → 400", async () => {
    expect((await api("GET", "/runs?limit=0")).status).toBe(400);
    expect((await api("GET", "/runs?limit=1.5")).status).toBe(400);
    expect((await api("GET", "/runs?limit=201")).status).toBe(400);
    expect((await api("GET", "/runs?before=abc")).status).toBe(400);
    expect((await api("GET", "/runs?before=1.5")).status).toBe(400);
    expect((await api("GET", "/runs?limit=200")).status).toBe(200);
  });
});

describe("run", () => {
  // Modello di un account `custom` verso il finto provider `llm`, collegato agli agenti delle run
  let modelId: number;
  let ownerId: number;
  let restoreLoopback: () => void;

  beforeAll(async () => {
    restoreLoopback = allowTestLoopback();
    const [owner] = await db.insert(usersTable).values({ email: "routes-run@example.com", name: "R" }).returning();
    ownerId = owner!.id;
    const [account] = await db
      .insert(aiAccountsTable)
      .values({
        userId: ownerId,
        name: "Account delle run",
        provider: "custom",
        baseUrl: llmBase,
        allowPrivateNetwork: true,
        apiKeyEnc: encryptSecret("sk-test"),
        status: "ok",
      })
      .returning();
    const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "modello", displayName: "M" }).returning();
    modelId = model!.id;
  });

  afterAll(async () => {
    await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
    await db.delete(usersTable).where(eq(usersTable.id, ownerId));
    restoreLoopback();
  });

  /** Agente generale dell'app con il modello di prova. */
  async function runnableAgent(appId: number) {
    const general = await generalAgentOf(appId);
    await db.update(agentsTable).set({ aiModelId: modelId, model: "modello" }).where(eq(agentsTable.id, general.id));
    return general;
  }

  const QUEUE_FIELDS = { destinatario: "Rosa", sintesi: "Elimina l'elemento 42" };

  /** Run conclusa con un'azione L2 accodata (passi: model, queued, model). */
  async function queuedRun(): Promise<number> {
    const app = await createApp();
    await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL);
    const general = await runnableAgent(app.id);
    const [run] = await db.insert(runsTable).values({ agentId: general.id, input: "Elimina 42" }).returning();
    llmReplies = [toolCallReply("delete_item", { id: "42", ...QUEUE_FIELDS }), textReply("In coda.")];
    setUserToken(run!.id, USER_TOKEN);
    await startRun(run!.id);
    expect((await getRun(run!.id)).status).toBe("succeeded");
    return run!.id;
  }

  it("trigger su un agente senza modello → 409 'scegli un modello per l'agente', nessuna run", async () => {
    const app = await createApp();
    const general = await generalAgentOf(app.id);
    expect(general).toHaveProperty("aiModelId", null);
    const res = await api("POST", `/agents/${general.id}/runs`, { input: "Fai" });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "scegli un modello per l'agente" });
    expect(await db.select().from(runsTable)).toHaveLength(0);
  });

  it("trigger: legge X-App-User-Token, 202 pending; il token arriva all'app e non è salvato", async () => {
    const app = await createApp();
    await api("POST", `/apps/${app.id}/tools`, { ...HTTP_TOOL, level: "L0" });
    const general = await runnableAgent(app.id);
    llmReplies = [toolCallReply("delete_item", { id: "7" }), textReply("ok")];
    const res = await api("POST", `/agents/${general.id}/runs`, { input: "Elimina 7" }, { "X-App-User-Token": ` ${USER_TOKEN} ` });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe("pending");
    const run = await waitForStatus(res.json.id, ["failed", "succeeded"]);
    expect(run.status).toBe("succeeded");
    expect(appRequests).toEqual([{ method: "DELETE", url: "/api/items/7", auth: `Bearer ${USER_TOKEN}` }]);
    const dump = await pool.query("select (select json_agg(r)::text from runs r) as runs, (select json_agg(s)::text from run_steps s) as steps");
    expect(dump.rows[0].runs).not.toContain(USER_TOKEN);
    expect(dump.rows[0].steps ?? "").not.toContain(USER_TOKEN);
  });

  it("trigger con 200 run in attesa dell'agente → 429 «troppe run in attesa per questo agente», nessuna run creata", async () => {
    const app = await createApp();
    const general = await runnableAgent(app.id);
    await pool.query(
      `insert into runs (agent_id, ai_model_id, status, input) select $1, $2, 'pending', 'x' from generate_series(1, 200)`,
      [general.id, modelId],
    );
    const res = await api("POST", `/agents/${general.id}/runs`, { input: "Una di troppo" });
    // Le run in attesa non devono partire dopo il test
    await pool.query(`update runs set status = 'cancelled' where status = 'pending'`);
    expect(res.status).toBe(429);
    expect(res.json).toEqual({ error: "troppe run in attesa per questo agente" });
    expect((await db.select().from(runsTable)).length).toBe(200);
  });

  it("GET della run: niente azione in sospeso né stato del ciclo", async () => {
    const id = await queuedRun();
    const res = await api("GET", `/runs/${id}`);
    expect(res.status).toBe(200);
    expect(res.json).not.toHaveProperty("pendingAction");
    expect(res.json).not.toHaveProperty("loopState");
    expect(res.json.promptTokens).toBe(20);
    const list = await api("GET", "/runs");
    expect(list.text).not.toContain("loopState");
    expect(list.text).not.toContain("pendingAction");
  });

  it("passi della run in ordine di posizione con il passo queued; run inesistente → 404", async () => {
    const id = await queuedRun();
    const res = await api("GET", `/runs/${id}/steps`);
    expect(res.status).toBe(200);
    expect(res.json.map((s: { position: number; type: string }) => [s.position, s.type])).toEqual([
      [0, "model"],
      [1, "queued"],
      [2, "model"],
    ]);
    expect(res.json[1].args).toEqual({ numero: 1, destinatario: "Rosa", sintesi: "Elimina l'elemento 42", argomenti: { id: "42" } });
    expect((await api("GET", "/runs/9999/steps")).status).toBe(404);
  });

  it("cancel: run pending → 200 cancelled; già conclusa → 409; inesistente → 404", async () => {
    const app = await createApp();
    const general = await runnableAgent(app.id);
    const [run] = await db.insert(runsTable).values({ agentId: general.id, input: "x" }).returning();
    const res = await api("POST", `/runs/${run!.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: run!.id, status: "cancelled", errorMessage: "Annullata dall'utente." });
    expect(res.json).not.toHaveProperty("loopState");
    const again = await api("POST", `/runs/${run!.id}/cancel`);
    expect(again.status).toBe(409);
    expect(typeof again.json.error).toBe("string");
    expect((await api("POST", "/runs/9999/cancel")).status).toBe(404);
  });

  it("argomenti del modello non JSON: GET dei passi → 200 con { _raw }", async () => {
    const app = await createApp();
    await api("POST", `/apps/${app.id}/tools`, HTTP_TOOL);
    const general = await runnableAgent(app.id);
    const [run] = await db.insert(runsTable).values({ agentId: general.id, input: "x" }).returning();
    llmReplies = [rawToolCallReply("delete_item", "{non json"), textReply("Non riesco.")];
    setUserToken(run!.id, USER_TOKEN);
    await startRun(run!.id);

    const res = await api("GET", `/runs/${run!.id}/steps`);
    expect(res.status).toBe(200);
    const tool = res.json.find((s: { type: string }) => s.type === "tool");
    expect(tool.args).toEqual({ _raw: "{non json" });
  });

  it("risposta che non rispetta il contratto (ZodError della risposta) → 500 generico", async () => {
    const app = await createApp();
    const general = await runnableAgent(app.id);
    const [run] = await db.insert(runsTable).values({ agentId: general.id, input: "x" }).returning();
    // Riga scritta prima della correzione: args come stringa JSON invece di un oggetto
    await pool.query(
      `insert into run_steps (run_id, position, type, tool_name, args, ok, duration_ms) values ($1, 0, 'tool', 'x', '"grezzo"'::jsonb, false, 0)`,
      [run!.id],
    );
    const res = await api("GET", `/runs/${run!.id}/steps`);
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "Errore interno" });
  });

  it("GET dei passi di una run con un'azione L2 sensibile: nessun valore sensibile nella risposta", async () => {
    const app = await createApp();
    await api("POST", `/apps/${app.id}/tools`, {
      ...HTTP_TOOL,
      name: "set_password",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" }, password: { type: "string", "x-sensitive": true } },
        required: ["id", "password"],
      },
      definition: { method: "PATCH", path: "/items/{id}", paramLocations: { id: "path", password: "body" } },
    });
    const general = await runnableAgent(app.id);
    const [run] = await db.insert(runsTable).values({ agentId: general.id, input: "x" }).returning();
    llmReplies = [toolCallReply("set_password", { id: "42", password: "segreta-123", ...QUEUE_FIELDS }), textReply("In coda.")];
    setUserToken(run!.id, USER_TOKEN);
    await startRun(run!.id);
    expect((await getRun(run!.id)).status).toBe("succeeded");

    const res = await api("GET", `/runs/${run!.id}/steps`);
    expect(res.status).toBe(200);
    const queued = res.json.find((s: { type: string }) => s.type === "queued");
    expect(queued.args.argomenti).toEqual({ id: "42", password: "***" });
    expect(res.text).not.toContain("segreta-123");
    expect((await api("GET", `/runs/${run!.id}`)).text).not.toContain("segreta-123");
    expect(appRequests).toHaveLength(0);
  });
});
