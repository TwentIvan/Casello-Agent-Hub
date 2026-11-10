import { describe, expect, it } from "vitest";
import { createPairingClient, type PairingClient, type PollResult } from "./client";
import type { Dialogs } from "./dialogs";
import { PairingFailedError, runPairing } from "./pairing";

const START = {
  pairingId: "p-1",
  userCode: "ABCD-EFGH",
  pollSecret: "segreto-di-poll-0123456789",
  expiresAt: new Date("2026-11-10T10:10:00.000Z"),
};

function fakeDialogs(log: string[]): Dialogs {
  return {
    alert: async (t) => void log.push(`alert:${t}`),
    notify: async (title, t) => void log.push(`notify:${title}:${t}`),
    chooseFolder: async () => null,
    chooseFromList: async () => null,
    confirm: async () => false,
  };
}

function scriptedClient(results: Array<PollResult | Error>, polls: string[] = []): PairingClient {
  return {
    start: async () => START,
    poll: async (id, secret) => {
      polls.push(`${id}:${secret}`);
      const next = results.shift();
      if (!next) throw new Error("poll inatteso");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function clock(startIso = "2026-11-10T10:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("runPairing", () => {
  it("apre la pagina del codice, notifica il codice, attende due pending e restituisce il token", async () => {
    const log: string[] = [];
    const opened: string[] = [];
    const polls: string[] = [];
    const sleeps: number[] = [];
    const c = clock();
    const result = await runPairing({
      caselloUrl: "https://casello.example.com",
      client: scriptedClient(
        [{ status: "pending" }, { status: "pending" }, { status: "approved", token: "cas_nuovo", nodeId: 7, nodeName: "MacBook" }],
        polls,
      ),
      dialogs: fakeDialogs(log),
      openUrl: async (u) => void opened.push(u),
      sleep: async (ms) => {
        sleeps.push(ms);
        await c.sleep(ms);
      },
      now: c.now,
      deviceName: "MacBook",
      version: "0.3.0",
    });
    expect(result).toEqual({ token: "cas_nuovo", nodeId: 7, nodeName: "MacBook" });
    expect(opened).toEqual(["https://casello.example.com/nodes/pair?code=ABCD-EFGH"]);
    expect(log.some((l) => l.startsWith("notify:") && l.includes("ABCD-EFGH"))).toBe(true);
    expect(polls).toHaveLength(3);
    expect(polls[0]).toBe(`p-1:${START.pollSecret}`);
    expect(sleeps).toEqual([3000, 3000, 3000]);
  });

  it("410 → dialogo «Collegamento non riuscito o scaduto» ed errore", async () => {
    const log: string[] = [];
    const c = clock();
    await expect(
      runPairing({
        caselloUrl: "https://casello.example.com",
        client: scriptedClient([{ status: "pending" }, { status: "gone" }]),
        dialogs: fakeDialogs(log),
        openUrl: async () => {},
        sleep: c.sleep,
        now: c.now,
        deviceName: "Mac",
        version: "0.3.0",
      }),
    ).rejects.toBeInstanceOf(PairingFailedError);
    expect(log).toContain("alert:Collegamento non riuscito o scaduto: riapri Botcave Nodo");
  });

  it("errori temporanei del poll non fermano l'attesa; oltre la scadenza → errore", async () => {
    const log: string[] = [];
    const c = clock("2026-11-10T10:09:55.000Z");
    await expect(
      runPairing({
        caselloUrl: "https://casello.example.com",
        client: scriptedClient([new Error("rete"), { status: "pending" }, { status: "pending" }]),
        dialogs: fakeDialogs(log),
        openUrl: async () => {},
        sleep: c.sleep,
        now: c.now,
        deviceName: "Mac",
        version: "0.3.0",
      }),
    ).rejects.toBeInstanceOf(PairingFailedError);
    expect(log).toContain("alert:Collegamento non riuscito o scaduto: riapri Botcave Nodo");
  });
});

describe("createPairingClient", () => {
  function fakeFetch(responses: Response[], seen: Array<{ url: string; init: RequestInit }>): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      const r = responses.shift();
      if (!r) throw new Error("nessuna risposta");
      return r;
    }) as typeof fetch;
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("start e poll senza Authorization; 202, 200 e 410", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = createPairingClient({
      baseUrl: "https://casello.example.com",
      fetch: fakeFetch(
        [
          json(201, { ...START, expiresAt: START.expiresAt.toISOString() }),
          json(202, { status: "pending" }),
          json(200, { status: "approved", token: "cas_x", nodeId: 3, nodeName: "Mac" }),
          json(410, { error: "collegamento non più valido" }),
        ],
        seen,
      ),
    });
    expect(await client.start({ deviceName: "Mac", version: "0.3.0" })).toEqual(START);
    expect(await client.poll("p-1", "s")).toEqual({ status: "pending" });
    expect(await client.poll("p-1", "s")).toEqual({ status: "approved", token: "cas_x", nodeId: 3, nodeName: "Mac" });
    expect(await client.poll("p-1", "s")).toEqual({ status: "gone" });
    expect(seen[0]!.url).toBe("https://casello.example.com/api/node-pairing/start");
    expect(seen[1]!.url).toBe("https://casello.example.com/api/node-pairing/poll");
    for (const s of seen) {
      expect(new Headers(s.init.headers).get("authorization")).toBeNull();
      expect(s.init.redirect).toBe("error");
    }
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ pairingId: "p-1", pollSecret: "s" });
  });

  it("poll con 5xx o 429 → errore (temporaneo), start con 4xx → errore", async () => {
    const client = createPairingClient({
      baseUrl: "https://casello.example.com",
      fetch: fakeFetch([json(503, {}), json(429, {}), json(400, { error: "x" })], []),
    });
    await expect(client.poll("p", "s")).rejects.toThrow();
    await expect(client.poll("p", "s")).rejects.toThrow();
    await expect(client.start({ deviceName: "Mac", version: "0.3.0" })).rejects.toThrow();
  });
});
