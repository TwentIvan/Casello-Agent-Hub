import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, agentsTable, appsTable, pendingActionsTable, runsTable, usersTable } from "@workspace/db";
import { publishRunChange, runChangeListenerCount } from "../lib/live/events";

// Aggiornamenti in tempo reale (issue #108) sull'app completa senza login (AUTH_DISABLED=true: utente dev@localhost).
// Nessuno scheduler delle run: le run inserite a mano restano nello stato scelto.

let base: string;
let server: http.Server;
// Importati dopo AUTH_DISABLED: il modulo delle route carica la configurazione del login
let LIVE_MAX_STREAMS_PER_USER: number;
let liveStreamCount: (userId: number) => number;
const saved: Record<string, string | undefined> = {};

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method, headers });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function devUserId(): Promise<number> {
  await api("GET", "/auth/me");
  const [u] = await db.select().from(usersTable).where(eq(usersTable.email, "dev@localhost"));
  return u!.id;
}

async function createAgent(): Promise<{ appId: number; agentId: number }> {
  const slug = `live-${Math.random().toString(36).slice(2, 8)}`;
  const [app] = await db.insert(appsTable).values({ name: slug, slug, baseUrl: "http://live.example" }).returning();
  const [agent] = await db.insert(agentsTable).values({ appId: app!.id, name: "Area", status: "active" }).returning();
  return { appId: app!.id, agentId: agent!.id };
}

async function addRun(agentId: number, status: (typeof runsTable.$inferInsert)["status"], parentRunId: number | null = null) {
  const [run] = await db.insert(runsTable).values({ agentId, status, input: "x", parentRunId }).returning();
  return run!.id;
}

/** Legge il flusso SSE finché `until` è vero sul testo ricevuto; poi chiude. */
async function readStream(
  controller: AbortController,
  res: Response,
  until: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    while (!until(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // interrotto dal timeout: il testo raccolto basta per le asserzioni
  } finally {
    clearTimeout(timer);
  }
  return text;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeAll(async () => {
  for (const k of ["AUTH_DISABLED", "ALLOWED_EMAILS"]) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  // I token personali con AUTH_DISABLED valgono solo per dev@localhost ammesso
  process.env["ALLOWED_EMAILS"] = "dev@localhost";
  const { default: app } = await import("../app");
  ({ LIVE_MAX_STREAMS_PER_USER, liveStreamCount } = await import("./live"));
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("GET /api/agent-activity", () => {
  it("in lavoro con run in corso o in coda, in attesa dell'utente con una voce in coda o un'azione del client, fermo senza", async () => {
    const userId = await devUserId();
    const working = await createAgent();
    const parent = await createAgent();
    const waiting = await createAgent();
    const client = await createAgent();
    const idle = await createAgent();

    await addRun(working.agentId, "running");
    await addRun(working.agentId, "pending");
    await addRun(working.agentId, "succeeded");
    // Run figlia ancora aperta (segnalazione al Responsabile): il padre ha finito ma conta come in lavoro
    const parentRun = await addRun(parent.agentId, "succeeded");
    await addRun(working.agentId, "pending", parentRun);
    const waitingRun = await addRun(waiting.agentId, "succeeded");
    await db.insert(pendingActionsTable).values({
      userId,
      number: 900_000 + Math.floor(Math.random() * 99_999),
      kind: "proposal",
      appId: waiting.appId,
      runId: waitingRun,
      agentId: waiting.agentId,
      argsEnc: "x",
      argsPublic: {},
      recipient: "app",
      summary: "voce",
    });
    await addRun(client.agentId, "awaiting_client");
    await addRun(idle.agentId, "failed");

    const res = await api("GET", "/agent-activity");
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byAgent = new Map<number, any>(res.json.map((a: any) => [a.agentId, a]));
    expect(byAgent.get(working.agentId)).toEqual({
      agentId: working.agentId,
      state: "working",
      runningRuns: 1,
      pendingRuns: 2,
      awaitingClientRuns: 0,
      activeChildRuns: 0,
      pendingActions: 0,
    });
    expect(byAgent.get(parent.agentId)).toMatchObject({ state: "working", activeChildRuns: 1, runningRuns: 0, pendingRuns: 0 });
    expect(byAgent.get(waiting.agentId)).toMatchObject({ state: "waiting_user", pendingActions: 1 });
    expect(byAgent.get(client.agentId)).toMatchObject({ state: "waiting_user", awaitingClientRuns: 1 });
    expect(byAgent.has(idle.agentId)).toBe(false);
  });
});

describe("GET /api/live", () => {
  it("manda ready, poi gli avvisi delle run raccolti in un solo messaggio; chiusa la connessione toglie l'ascoltatore", async () => {
    const userId = await devUserId();
    const before = runChangeListenerCount();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/live`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await waitFor(() => runChangeListenerCount() === before + 1);
    expect(liveStreamCount(userId)).toBe(1);

    publishRunChange(41, 7);
    publishRunChange(41, null);
    publishRunChange(42, null);
    const text = await readStream(controller, res, (t) => t.includes("event: runs"));
    controller.abort();

    expect(text).toContain("event: ready");
    const runsEvents = text.split("\n\n").filter((block) => block.includes("event: runs"));
    expect(runsEvents).toHaveLength(1);
    const data = JSON.parse(runsEvents[0]!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data).toEqual({ runs: [{ runId: 41, agentId: 7 }, { runId: 42, agentId: null }] });

    await waitFor(() => runChangeListenerCount() === before);
    expect(runChangeListenerCount()).toBe(before);
    await waitFor(() => liveStreamCount(userId) === 0);
    expect(liveStreamCount(userId)).toBe(0);
  });

  it("oltre i flussi ammessi per utente → 429", async () => {
    const userId = await devUserId();
    const controllers: AbortController[] = [];
    for (let i = 0; i < LIVE_MAX_STREAMS_PER_USER; i++) {
      const c = new AbortController();
      controllers.push(c);
      const res = await fetch(`${base}/api/live`, { signal: c.signal });
      expect(res.status).toBe(200);
    }
    await waitFor(() => liveStreamCount(userId) === LIVE_MAX_STREAMS_PER_USER);
    const over = await api("GET", "/live");
    expect(over.status).toBe(429);
    expect(over.json.error).toBe("troppi aggiornamenti in tempo reale aperti: chiudi qualche scheda");
    for (const c of controllers) c.abort();
    await waitFor(() => liveStreamCount(userId) === 0);
    expect(liveStreamCount(userId)).toBe(0);
  });

  it("con un token personale → 403 (solo login); l'attività degli agenti vale anche con api:read", async () => {
    const { createApiToken } = await import("../lib/api-tokens");
    const { token } = await createApiToken(await devUserId(), "live", 1, ["api:read"]);
    const auth = { authorization: `Bearer ${token}` };
    const res = await api("GET", "/live", auth);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("operazione disponibile solo con il login");
    expect((await api("GET", "/agent-activity", auth)).status).toBe(200);
  });
});
