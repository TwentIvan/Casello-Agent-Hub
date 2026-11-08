import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  agentTriggersTable,
  appToolsTable,
  runsTable,
  triggerSeenItemsTable,
  usersTable,
  type AgentTrigger,
} from "@workspace/db";
import { pollTrigger, sweepSeenItems } from "./poller";
import { updateTrigger } from "./service";
import { toolUsableByTrigger } from "./eligibility";
import { TRIGGER_MESSAGES } from "./messages";
import { MAX_PENDING_PER_AGENT } from "../run-queue";
import { encryptSecret } from "../secrets";
import { allowTestLoopback } from "../../../test/fake-provider";
import { startFakeMcp, type FakeMcp } from "../../../test/fake-mcp";

// Tetto di spesa: di norma quello vero; un test può sostituirlo per eseguire qualcosa a metà giro.
const budgetHook = vi.hoisted(() => ({ fn: null as null | (() => Promise<string | null>) }));
vi.mock("../budget", async () => {
  const actual = await vi.importActual<typeof import("../budget")>("../budget");
  return {
    ...actual,
    runBudgetBlock: (...args: Parameters<typeof actual.runBudgetBlock>) =>
      budgetHook.fn ? budgetHook.fn() : actual.runBudgetBlock(...args),
  };
});

// Giro di sorveglianza contro una finta app HTTP: la risposta è configurabile per test, le richieste
// (con la query) si registrano. Lo scheduler delle run non parte: le run create restano `pending`.

let appServer: http.Server;
let appBase: string;
let appStatus: number;
let appBody: unknown;
let appRequests: URL[];
/** Chiamato prima di rispondere (es. mettere in pausa l'innesco a giro in corso). */
let beforeReply: (() => Promise<void>) | null;
const savedKey = process.env["CASELLO_SECRET_KEY"];
let restoreLoopback: () => void;

beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});

beforeEach(async () => {
  budgetHook.fn = null;
  appStatus = 200;
  appBody = [];
  appRequests = [];
  beforeReply = null;
  appServer = http.createServer((req, res) => {
    appRequests.push(new URL(req.url ?? "/", "http://app.local"));
    void (async () => {
      if (beforeReply) await beforeReply();
      res.statusCode = appStatus;
      res.setHeader("content-type", "application/json");
      res.end(typeof appBody === "string" ? appBody : JSON.stringify(appBody));
    })();
  });
  await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", () => resolve()));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  appServer.closeAllConnections();
  await new Promise((r) => appServer.close(r));
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  restoreLoopback();
});

type Seed = {
  agent?: Partial<typeof agentsTable.$inferInsert>;
  app?: Partial<typeof appsTable.$inferInsert>;
  tool?: Partial<typeof appToolsTable.$inferInsert>;
  trigger?: Partial<typeof agentTriggersTable.$inferInsert>;
};

/** App con autenticazione di servizio, agente attivo con modello, tool L0 e innesco attivo e scaduto. */
async function seed(opts: Seed = {}): Promise<{ trigger: AgentTrigger; agentId: number; toolId: number }> {
  const [owner] = await db.insert(usersTable).values({ email: "inneschi@example.com", name: "Inneschi" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: owner!.id,
      name: "Account di prova",
      provider: "custom",
      baseUrl: "http://127.0.0.1:9/v1",
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "modello-base", displayName: "Base" })
    .returning();
  const [app] = await db
    .insert(appsTable)
    .values({
      name: "Mister",
      slug: "mister",
      baseUrl: "http://mister.example",
      internalBaseUrl: appBase,
      serviceAuth: { header: "X-Api-Key", scheme: null },
      serviceSecretEnc: encryptSecret("segreto-di-servizio"),
      ...opts.app,
    })
    .returning();
  const [agent] = await db
    .insert(agentsTable)
    .values({
      appId: app!.id,
      name: "Smistatore",
      role: "area",
      status: "active",
      model: "modello-base",
      aiModelId: model!.id,
      ...opts.agent,
    })
    .returning();
  const [tool] = await db
    .insert(appToolsTable)
    .values({
      appId: app!.id,
      name: "elenco_email",
      description: "Email arrivate",
      kind: "http",
      identity: "service",
      level: "L0",
      status: "active",
      definition: { method: "GET", path: "/emails", paramLocations: { since: "query", box: "query" } },
      paramsSchema: { type: "object", properties: { since: { type: "string" }, box: { type: "string" } } },
      ...opts.tool,
    })
    .returning();
  const [trigger] = await db
    .insert(agentTriggersTable)
    .values({
      agentId: agent!.id,
      kind: "poll",
      name: "Email",
      status: "active",
      toolId: tool!.id,
      args: { box: "in" },
      idField: "id",
      intervalSeconds: 300,
      nextPollAt: new Date(Date.now() - 1000),
      ...opts.trigger,
    })
    .returning();
  return { trigger: trigger!, agentId: agent!.id, toolId: tool!.id };
}

async function getTrigger(id: number): Promise<AgentTrigger> {
  const [row] = await db.select().from(agentTriggersTable).where(eq(agentTriggersTable.id, id));
  return row!;
}

async function keys(triggerId: number): Promise<string[]> {
  const rows = await db
    .select({ k: triggerSeenItemsTable.itemKey })
    .from(triggerSeenItemsTable)
    .where(eq(triggerSeenItemsTable.triggerId, triggerId))
    .orderBy(asc(triggerSeenItemsTable.itemKey));
  return rows.map((r) => r.k);
}

async function triggerRuns(triggerId: number) {
  return db.select().from(runsTable).where(eq(runsTable.triggerId, triggerId)).orderBy(asc(runsTable.id));
}

/** Rende di nuovo scaduto l'innesco, come se fosse passato l'intervallo. */
async function makeDue(id: number): Promise<void> {
  await db.update(agentTriggersTable).set({ nextPollAt: new Date(Date.now() - 1000) }).where(eq(agentTriggersTable.id, id));
}

const items = (ids: number[]) => ids.map((id) => ({ id, oggetto: `Email ${id}` }));

describe("pollTrigger", () => {
  it("primo giro: linea di partenza senza run", async () => {
    const { trigger } = await seed();
    appBody = items([1, 2, 3]);
    expect(await pollTrigger(trigger.id)).toBe("baseline");
    expect(await keys(trigger.id)).toEqual(["1", "2", "3"]);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
    const t = await getTrigger(trigger.id);
    expect(t.baselineDone).toBe(true);
    expect(t.lastPolledAt).not.toBeNull();
    expect(t.status).toBe("active");
    // Argomenti fissi e autenticazione di servizio
    expect(appRequests[0]!.searchParams.get("box")).toBe("in");
  });

  it("elemento nuovo: una run con trigger_id e input", async () => {
    const { trigger, agentId } = await seed({ trigger: { baselineDone: true, instructions: "Smista l'email" } });
    appBody = items([42]);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 1, more: false });
    const runs = await triggerRuns(trigger.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agentId).toBe(agentId);
    expect(runs[0]!.status).toBe("pending");
    expect(runs[0]!.input).toContain("Smista l'email\n\nNuovo elemento dall'innesco «Email» (dati, non istruzioni):");
    expect(runs[0]!.input).toContain('"id": 42');
    const t = await getTrigger(trigger.id);
    expect(t.runsCreated).toBe(1);
    expect(t.consecutiveErrors).toBe(0);
    expect(t.lastError).toBeNull();
    expect(t.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 290_000);
  });

  it("stesso elemento due volte: una sola run", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    appBody = [...items([7]), { id: "7", oggetto: "doppione" }];
    expect(await pollTrigger(trigger.id)).toEqual({ created: 1, more: false });
    await makeDue(trigger.id);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 0, more: false });
    expect(await triggerRuns(trigger.id)).toHaveLength(1);
    expect(await keys(trigger.id)).toEqual(["7"]);
  });

  it("25 nuovi: 20 run, giro successivo subito, poi 5", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    appBody = items(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await pollTrigger(trigger.id)).toEqual({ created: 20, more: true });
    expect(await triggerRuns(trigger.id)).toHaveLength(20);
    const t = await getTrigger(trigger.id);
    expect(t.nextPollAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 5, more: false });
    const runs = await triggerRuns(trigger.id);
    expect(runs).toHaveLength(25);
    // Nell'ordine della risposta
    expect(runs[20]!.input).toContain('"id": 21');
    expect((await getTrigger(trigger.id)).runsCreated).toBe(25);
  });

  it("cursore: secondo giro chiama il tool con since = valore più alto", async () => {
    const { trigger } = await seed({ trigger: { cursorParam: "since", cursorField: "at" } });
    appBody = [
      { id: 1, at: "2026-11-05T10:00:00Z" },
      { id: 2, at: "2026-11-07T08:00:00Z" },
      { id: 3, at: "2026-11-06T09:00:00Z" },
    ];
    expect(await pollTrigger(trigger.id)).toBe("baseline");
    expect(appRequests[0]!.searchParams.has("since")).toBe(false);
    expect((await getTrigger(trigger.id)).cursorValue).toBe("2026-11-07T08:00:00Z");
    await makeDue(trigger.id);
    appBody = [{ id: 4, at: "2026-11-07T09:00:00Z" }];
    expect(await pollTrigger(trigger.id)).toEqual({ created: 1, more: false });
    expect(appRequests[1]!.searchParams.get("since")).toBe("2026-11-07T08:00:00Z");
    expect((await getTrigger(trigger.id)).cursorValue).toBe("2026-11-07T09:00:00Z");
  });

  it("cursore: non supera un elemento rimasto per il giro dopo", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true, cursorParam: "since", cursorField: "n" } });
    // Il ventunesimo ha il cursore più basso: il cursore resta sotto di lui
    appBody = [...Array.from({ length: 20 }, (_, i) => ({ id: i + 1, n: 100 + i })), { id: 21, n: 50 }];
    expect(await pollTrigger(trigger.id)).toEqual({ created: 20, more: true });
    expect((await getTrigger(trigger.id)).cursorValue).toBeNull();
    expect(await pollTrigger(trigger.id)).toEqual({ created: 1, more: false });
    expect((await getTrigger(trigger.id)).cursorValue).toBe("50");
    // Al secondo giro il cursore era ancora vuoto
    expect(appRequests[1]!.searchParams.has("since")).toBe(false);
  });

  it("coda piena al terzo elemento: due run, terzo ripreso al giro dopo", async () => {
    const { trigger, agentId } = await seed({ trigger: { baselineDone: true } });
    // MAX_PENDING_PER_AGENT - 2 run già in attesa: c'è posto per due
    await pool.query(
      `INSERT INTO runs (agent_id, status, input) SELECT $1, 'pending', 'vecchia' FROM generate_series(1, $2)`,
      [agentId, MAX_PENDING_PER_AGENT - 2],
    );
    appBody = items([1, 2, 3, 4]);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 2, more: false });
    expect(await triggerRuns(trigger.id)).toHaveLength(2);
    // La chiave del terzo non è segnata: la sua transazione si è annullata
    expect(await keys(trigger.id)).toEqual(["1", "2"]);
    const t = await getTrigger(trigger.id);
    expect(t.consecutiveErrors).toBe(0);
    expect(t.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 290_000);

    // Si libera la coda: il giro dopo riprende dal terzo
    await db.delete(runsTable).where(and(eq(runsTable.agentId, agentId), eq(runsTable.input, "vecchia")));
    await makeDue(trigger.id);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 2, more: false });
    const runs = await triggerRuns(trigger.id);
    expect(runs.map((r) => (r.input!.match(/"id": (\d+)/) ?? [])[1])).toEqual(["1", "2", "3", "4"]);
  });

  it("tetto raggiunto: nessuna chiave, last_error budgetWait, consecutive_errors 0", async () => {
    const { trigger } = await seed({ agent: { monthlyBudgetUsd: "0" }, trigger: { baselineDone: true } });
    appBody = items([1]);
    expect(await pollTrigger(trigger.id)).toBe("skipped");
    expect(appRequests).toHaveLength(0);
    expect(await keys(trigger.id)).toEqual([]);
    const t = await getTrigger(trigger.id);
    expect(t.lastError).toBe(TRIGGER_MESSAGES.budgetWait);
    expect(t.consecutiveErrors).toBe(0);
    expect(t.status).toBe("active");
  });

  it("elenco sparito: errore senza toccare le chiavi", async () => {
    const { trigger } = await seed({ trigger: { itemsPath: "data.items" } });
    appBody = { data: { items: items([1, 2]) } };
    expect(await pollTrigger(trigger.id)).toBe("baseline");
    await makeDue(trigger.id);
    appBody = { data: { items: { id: 3 } } };
    expect(await pollTrigger(trigger.id)).toEqual({ error: TRIGGER_MESSAGES.listNotFound });
    expect(await keys(trigger.id)).toEqual(["1", "2"]);
    const t = await getTrigger(trigger.id);
    expect(t.baselineDone).toBe(true);
    expect(t.lastError).toBe(TRIGGER_MESSAGES.listNotFound);
    expect(t.consecutiveErrors).toBe(1);
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("risposta non JSON: risposta non riconosciuta", async () => {
    const { trigger } = await seed();
    appBody = "<html>non json</html>";
    expect(await pollTrigger(trigger.id)).toEqual({ error: TRIGGER_MESSAGES.unrecognized });
  });

  it("HTTP 500: backoff, dopo 10 errori status = error", async () => {
    const { trigger } = await seed({ trigger: { intervalSeconds: 60 } });
    appStatus = 500;
    appBody = { error: "segreto dell'app nel messaggio" };
    const out = await pollTrigger(trigger.id);
    expect(out).toHaveProperty("error");
    let t = await getTrigger(trigger.id);
    expect(t.lastError).not.toContain("segreto");
    expect(t.lastError).toContain(TRIGGER_MESSAGES.toolFailed);
    expect(t.consecutiveErrors).toBe(1);
    const delay = t.nextPollAt!.getTime() - Date.now();
    expect(delay).toBeGreaterThan(110_000);
    expect(delay).toBeLessThan(125_000);

    for (let i = 2; i <= 10; i++) {
      await makeDue(trigger.id);
      await pollTrigger(trigger.id);
    }
    t = await getTrigger(trigger.id);
    expect(t.consecutiveErrors).toBe(10);
    expect(t.status).toBe("error");
    // Il backoff non supera un'ora
    expect(t.nextPollAt!.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000);
    await makeDue(trigger.id);
    expect(await pollTrigger(trigger.id)).toBe("skipped");
  });

  it("tool diventato L1: errore toolNoLonger", async () => {
    const { trigger, toolId } = await seed();
    await db.update(appToolsTable).set({ levelOverride: "L1" }).where(eq(appToolsTable.id, toolId));
    expect(await pollTrigger(trigger.id)).toEqual({ error: TRIGGER_MESSAGES.toolNoLonger });
    expect(appRequests).toHaveLength(0);
    const t = await getTrigger(trigger.id);
    expect(t.status).toBe("error");
    expect(t.lastError).toBe(TRIGGER_MESSAGES.toolNoLonger);
  });

  it("agente in bozza: giro saltato senza errore", async () => {
    const { trigger } = await seed({ agent: { status: "draft" } });
    expect(await pollTrigger(trigger.id)).toBe("skipped");
    expect(appRequests).toHaveLength(0);
    const t = await getTrigger(trigger.id);
    expect(t.consecutiveErrors).toBe(0);
    expect(t.lastError).toBeNull();
    expect(t.status).toBe("active");
    // Riprova all'intervallo
    expect(t.nextPollAt!.getTime()).toBeGreaterThan(Date.now() + 290_000);
  });

  it("due pollTrigger concorrenti: un solo giro", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    appBody = items([1]);
    const outs = await Promise.all([pollTrigger(trigger.id), pollTrigger(trigger.id)]);
    expect(outs.filter((o) => o === "skipped")).toHaveLength(1);
    expect(appRequests).toHaveLength(1);
    expect(await triggerRuns(trigger.id)).toHaveLength(1);
  });

  it("pausa durante il giro: lo stato resta paused", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    appBody = items([1, 2]);
    beforeReply = async () => {
      await db.update(agentTriggersTable).set({ status: "paused" }).where(eq(agentTriggersTable.id, trigger.id));
    };
    await pollTrigger(trigger.id);
    const t = await getTrigger(trigger.id);
    expect(t.status).toBe("paused");
    expect(t.lastError).toBeNull();
    expect(t.consecutiveErrors).toBe(0);
    expect(t.lastPolledAt).toBeNull();
    // Nessuna run per un innesco messo in pausa
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
    expect(await keys(trigger.id)).toEqual([]);
  });

  it("pausa durante un giro in errore: lo stato resta paused", async () => {
    const { trigger } = await seed();
    appStatus = 500;
    beforeReply = async () => {
      await db.update(agentTriggersTable).set({ status: "paused" }).where(eq(agentTriggersTable.id, trigger.id));
    };
    await pollTrigger(trigger.id);
    const t = await getTrigger(trigger.id);
    expect(t.status).toBe("paused");
    expect(t.consecutiveErrors).toBe(0);
  });

  describe("tool mcp", () => {
    let mcp: FakeMcp;
    afterEach(async () => {
      await mcp?.close();
    });

    it("elementi da structuredContent", async () => {
      mcp = await startFakeMcp({
        tools: [{ name: "elenco", structuredContent: { items: items([5, 6]) }, text: "riassunto" }],
      });
      const { trigger } = await seed({
        app: { internalBaseUrl: null, mcpUrl: mcp.url },
        tool: { kind: "mcp", definition: { mcpName: "elenco" }, paramsSchema: { type: "object", properties: {} } },
        trigger: { itemsPath: "items", args: {} },
      });
      expect(await pollTrigger(trigger.id)).toBe("baseline");
      expect(await keys(trigger.id)).toEqual(["5", "6"]);
      expect(mcp.calls).toHaveLength(1);
    });

    it("risultato vuoto: risposta non riconosciuta", async () => {
      mcp = await startFakeMcp({ tools: [{ name: "elenco" }] });
      const { trigger } = await seed({
        app: { internalBaseUrl: null, mcpUrl: mcp.url },
        tool: { kind: "mcp", definition: { mcpName: "elenco" }, paramsSchema: { type: "object", properties: {} } },
        trigger: { args: {} },
      });
      expect(await pollTrigger(trigger.id)).toEqual({ error: TRIGGER_MESSAGES.unrecognized });
    });
  });
});

describe("sweepSeenItems", () => {
  it("tolte le chiavi oltre 30 giorni e oltre 10 000", async () => {
    const { trigger } = await seed();
    // 10 005 chiavi recenti (le più vecchie sono le prime) e 3 di 31 giorni fa
    await pool.query(
      `INSERT INTO trigger_seen_items (trigger_id, item_key, seen_at)
       SELECT $1, 'k' || g, now() - (20000 - g) * interval '1 second' FROM generate_series(1, 10005) g`,
      [trigger.id],
    );
    await pool.query(
      `INSERT INTO trigger_seen_items (trigger_id, item_key, seen_at)
       SELECT $1, 'old' || g, now() - interval '31 days' FROM generate_series(1, 3) g`,
      [trigger.id],
    );
    await sweepSeenItems();
    const [{ n }] = (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(triggerSeenItemsTable)
        .where(eq(triggerSeenItemsTable.triggerId, trigger.id))
    ) as [{ n: number }];
    expect(n).toBe(10_000);
    const left = await pool.query(
      `SELECT item_key FROM trigger_seen_items WHERE item_key IN ('k1','k5','k6','old1')`,
    );
    expect(left.rows.map((r: { item_key: string }) => r.item_key)).toEqual(["k6"]);
  });
});

describe("chiavi rivista", () => {
  const seenAt = async (triggerId: number, key: string) =>
    (
      await pool.query(`SELECT seen_at FROM trigger_seen_items WHERE trigger_id = $1 AND item_key = $2`, [triggerId, key])
    ).rows[0]?.seen_at as Date | undefined;

  it("una chiave rivista in un giro ha seen_at rinfrescato", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    await pool.query(
      `INSERT INTO trigger_seen_items (trigger_id, item_key, seen_at) VALUES ($1, '1', now() - interval '2 days'), ($1, '2', now() - interval '2 days')`,
      [trigger.id],
    );
    appBody = items([1]);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 0, more: false });
    expect(Date.now() - (await seenAt(trigger.id, "1"))!.getTime()).toBeLessThan(60_000);
    // Non restituita: resta com'era
    expect(Date.now() - (await seenAt(trigger.id, "2"))!.getTime()).toBeGreaterThan(86_400_000);
  });

  it("chiave di oltre 30 giorni ancora restituita: rinfrescata, sopravvive alla pulizia, nessuna run", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    await pool.query(
      `INSERT INTO trigger_seen_items (trigger_id, item_key, seen_at) VALUES ($1, '1', now() - interval '31 days')`,
      [trigger.id],
    );
    appBody = items([1]);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 0, more: false });
    await sweepSeenItems();
    expect(await keys(trigger.id)).toEqual(["1"]);
    await makeDue(trigger.id);
    expect(await pollTrigger(trigger.id)).toEqual({ created: 0, more: false });
    expect(await triggerRuns(trigger.id)).toHaveLength(0);
  });

  it("innesco in pausa a giro in corso: seen_at non rinfrescato", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    await pool.query(
      `INSERT INTO trigger_seen_items (trigger_id, item_key, seen_at) VALUES ($1, '1', now() - interval '2 days')`,
      [trigger.id],
    );
    appBody = items([1]);
    beforeReply = async () => {
      await db.update(agentTriggersTable).set({ status: "paused" }).where(eq(agentTriggersTable.id, trigger.id));
    };
    await pollTrigger(trigger.id);
    expect(Date.now() - (await seenAt(trigger.id, "1"))!.getTime()).toBeGreaterThan(86_400_000);
  });
});

describe("toolUsableByTrigger", () => {
  const base = {
    id: 1,
    appId: 1,
    kind: "http",
    identity: "service",
    level: "L0",
    levelOverride: null,
    status: "active",
  } as unknown as Parameters<typeof toolUsableByTrigger>[0];
  it("solo L0, service, active, http o mcp, stessa app", () => {
    expect(toolUsableByTrigger(base, 1)).toBe(true);
    expect(toolUsableByTrigger({ ...base, kind: "mcp" }, 1)).toBe(true);
    expect(toolUsableByTrigger(base, 2)).toBe(false);
    expect(toolUsableByTrigger({ ...base, kind: "ui" }, 1)).toBe(false);
    expect(toolUsableByTrigger({ ...base, identity: "user" }, 1)).toBe(false);
    expect(toolUsableByTrigger({ ...base, status: "draft" }, 1)).toBe(false);
    expect(toolUsableByTrigger({ ...base, levelOverride: "L1" }, 1)).toBe(false);
    expect(toolUsableByTrigger({ ...base, level: "L2" }, 1)).toBe(false);
  });
});

describe("modifica a giro in corso", () => {
  it("una PATCH che rifà la linea di partenza durante il giro di partenza non viene annullata", async () => {
    const { trigger } = await seed({ trigger: { cursorParam: "since", cursorField: "at" } });
    appBody = [{ id: 1, at: "2026-11-01" }, { id: 2, at: "2026-11-02" }];
    beforeReply = async () => {
      const res = await updateTrigger(trigger.id, { itemsPath: "items" });
      expect(res.ok).toBe(true);
    };
    expect(await pollTrigger(trigger.id)).toBe("skipped");
    const after = await getTrigger(trigger.id);
    expect(after.itemsPath).toBe("items");
    expect(after.baselineDone).toBe(false);
    expect(after.cursorValue).toBeNull();
    expect(await keys(trigger.id)).toEqual([]);
  });

  it("una PATCH durante un giro normale: nessuna run, nessuna chiave dalla configurazione vecchia", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true, cursorParam: "since", cursorField: "at", cursorValue: "2026-10-01" } });
    await db.insert(triggerSeenItemsTable).values({ triggerId: trigger.id, itemKey: "1" });
    appBody = [{ id: 1, at: "2026-11-01" }, { id: 2, at: "2026-11-02" }, { id: 3, at: "2026-11-03" }];
    beforeReply = async () => {
      const res = await updateTrigger(trigger.id, { itemsPath: "items" });
      expect(res.ok).toBe(true);
    };
    await pollTrigger(trigger.id);
    const after = await getTrigger(trigger.id);
    expect(after.baselineDone).toBe(false);
    expect(after.cursorValue).toBeNull();
    expect(after.runsCreated).toBe(0);
    expect(await keys(trigger.id)).toEqual([]);
    expect(await triggerRuns(trigger.id)).toEqual([]);
  });

  /** Secondo tool idoneo della stessa app dell'innesco. */
  async function otherTool(): Promise<number> {
    const [app] = await db.select().from(appsTable).limit(1);
    const [tool] = await db
      .insert(appToolsTable)
      .values({
        appId: app!.id,
        name: "elenco_bis",
        description: "Altre email",
        kind: "http",
        identity: "service",
        level: "L0",
        status: "active",
        definition: { method: "GET", path: "/emails", paramLocations: { box: "query" } },
        paramsSchema: { type: "object", properties: { box: { type: "string" } } },
      })
      .returning();
    return tool!.id;
  }

  it("una PATCH verso un altro tool a giro in corso non riceve l'errore del giro vecchio", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    const toolId = await otherTool();
    appStatus = 500;
    beforeReply = async () => {
      const res = await updateTrigger(trigger.id, { toolId });
      expect(res.ok).toBe(true);
    };
    await pollTrigger(trigger.id);
    const after = await getTrigger(trigger.id);
    expect(after.toolId).toBe(toolId);
    expect(after.status).toBe("active");
    expect(after.consecutiveErrors).toBe(0);
    expect(after.lastError).toBeNull();
  });

  it("una PATCH durante il controllo del tetto non riceve l'attesa del giro vecchio", async () => {
    const { trigger } = await seed({ trigger: { baselineDone: true } });
    const toolId = await otherTool();
    budgetHook.fn = async () => {
      const res = await updateTrigger(trigger.id, { toolId });
      expect(res.ok).toBe(true);
      return "tetto raggiunto";
    };
    expect(await pollTrigger(trigger.id)).toBe("skipped");
    const after = await getTrigger(trigger.id);
    expect(after.toolId).toBe(toolId);
    expect(after.lastError).toBeNull();
  });
});
