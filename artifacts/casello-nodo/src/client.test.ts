import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaselloClient, HttpError, LeaseLostError } from "./client";
import { FakeCasello, json } from "./test/fake-casello";
import { FAKE_TOKEN, taskPackage } from "./test/helpers";

let casello: FakeCasello;
let waits: number[];

function client(over: Partial<ConstructorParameters<typeof CaselloClient>[0]> = {}): CaselloClient {
  return new CaselloClient({
    baseUrl: casello.url,
    token: FAKE_TOKEN,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...over,
  });
}

beforeEach(async () => {
  casello = new FakeCasello();
  await casello.start();
  waits = [];
});
afterEach(async () => casello.close());

const caps = { version: "0.1.0", executor: "claude-code", skills: ["a"], workspaceRoot: "/w", maxConcurrent: 1 };

describe("CaselloClient", () => {
  it("heartbeat con il token d'ambito node", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 200, { pending: 2 }));
    expect(await client().heartbeat(caps)).toEqual({ pending: 2 });
    const [req] = casello.calls("POST", "/api/node/heartbeat");
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.body).toEqual(caps);
  });

  it("claim: 204 → null, 200 → pacchetto validato", async () => {
    casello.on("POST", "/api/node/claim", (_req, res) => json(res, 204));
    expect(await client().claim()).toBeNull();
    const pkg = taskPackage();
    casello.on("POST", "/api/node/claim", (_req, res) => json(res, 200, pkg));
    const got = await client().claim();
    expect(got?.taskId).toBe(42);
    expect(got?.leaseExpiresAt).toBeInstanceOf(Date);
  });

  it("claim con un pacchetto non valido → errore, nessun nuovo tentativo", async () => {
    casello.on("POST", "/api/node/claim", (_req, res) => json(res, 200, { taskId: "x" }));
    await expect(client().claim()).rejects.toThrow("pacchetto del compito non valido");
    expect(casello.calls("POST", "/api/node/claim")).toHaveLength(1);
  });

  it("ritenta con attesa crescente gli errori 5xx e 429", async () => {
    let n = 0;
    casello.on("POST", "/api/node/tasks/:id/ping", (_req, res) => {
      n++;
      if (n === 1) return json(res, 503, { error: "giù" });
      if (n === 2) return json(res, 429, { error: "Troppe richieste" });
      if (n === 3) return json(res, 502);
      return json(res, 200, { leaseExpiresAt: new Date(Date.now() + 900_000).toISOString() });
    });
    const expires = await client().ping(42, "lease-abc");
    expect(expires).toBeInstanceOf(Date);
    expect(n).toBe(4);
    expect(waits).toHaveLength(3);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
  });

  it("409 → LeaseLostError senza nuovi tentativi", async () => {
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) =>
      json(res, 409, { error: "lease non valida o scaduta" }),
    );
    await expect(
      client().report(42, { leaseToken: "lease-abc", status: "done", outcome: "fatto" }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(casello.calls("POST", "/api/node/tasks/42/report")).toHaveLength(1);
  });

  it("altri 4xx → HttpError senza nuovi tentativi", async () => {
    casello.on("POST", "/api/node/heartbeat", (_req, res) => json(res, 403, { error: "nodo disattivato" }));
    const err = await client()
      .heartbeat(caps)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as Error).message).toContain("nodo disattivato");
    expect(waits).toHaveLength(0);
  });

  it("ritenta gli errori di rete e si ferma oltre 5 minuti di attesa", async () => {
    await casello.close();
    const c = client({ baseUrl: "http://127.0.0.1:1" });
    await expect(c.heartbeat(caps)).rejects.toThrow("Botcave non raggiungibile");
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
    expect(waits.length).toBeGreaterThan(3);
    casello = new FakeCasello();
    await casello.start();
  });

  it("il report è validato con lo schema del contratto prima dell'invio", async () => {
    casello.on("POST", "/api/node/tasks/:id/report", (_req, res) => json(res, 204));
    await expect(
      client().report(42, { leaseToken: "lease-abc", status: "done", outcome: "x".repeat(301) }),
    ).rejects.toThrow();
    expect(casello.calls("POST", "/api/node/tasks/42/report")).toHaveLength(0);
    await client().report(42, { leaseToken: "lease-abc", status: "done", outcome: "fatto", costUsd: 0.1 });
    expect(casello.calls("POST", "/api/node/tasks/42/report")[0].body).toEqual({
      leaseToken: "lease-abc",
      status: "done",
      outcome: "fatto",
      costUsd: 0.1,
    });
  });

  it("scarica un allegato con l'header della lease", async () => {
    casello.on("GET", "/api/node/tasks/:id/attachments/:aid", (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([1, 2, 3]));
    });
    const data = await client().downloadAttachment(42, 9, "lease-abc");
    expect([...data]).toEqual([1, 2, 3]);
    const [req] = casello.calls("GET", "/api/node/tasks/42/attachments/9");
    expect(req.headers["x-lease-token"]).toBe("lease-abc");
  });

  it("un timeout della richiesta è un errore di rete ritentato", async () => {
    let n = 0;
    casello.on("POST", "/api/node/heartbeat", (_req, res) => {
      n++;
      if (n === 1) return; // nessuna risposta: scatta il timeout
      json(res, 200, { pending: 0 });
    });
    expect(await client({ timeoutMs: 200 }).heartbeat(caps)).toEqual({ pending: 0 });
    expect(n).toBe(2);
  });
});
