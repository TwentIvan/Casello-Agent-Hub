import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  db,
  pool,
  aiAccountsTable,
  aiModelsTable,
  appsTable,
  agentsTable,
  agentTriggersTable,
  runsTable,
  runStepsTable,
  usersTable,
  type Agent,
} from "@workspace/db";
import { cancelRun } from "./run-executor";
import {
  MAX_PENDING_PER_AGENT,
  MAX_RUNNING_PER_AGENT,
  MAX_RUNNING_RUNS,
  RUN_QUEUE_MESSAGES,
  createQueuedRun,
  scheduleRuns,
  startRunQueue,
} from "./run-queue";
import { getUserToken } from "./user-tokens";
import { logger } from "./logger";
import { encryptSecret } from "./secrets";
import { allowTestLoopback } from "../../test/fake-provider";

// Finto provider compatibile OpenAI: ogni richiesta resta in attesa finché il test non la rilascia,
// così le run restano `running` quanto serve.
let held: { body: any; res: http.ServerResponse }[];
let requests: any[];
let llm: http.Server;
let llmBase: string;
const savedKey = process.env["CASELLO_SECRET_KEY"];

function textReply(text: string) {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

/** Rilascia le prime `n` richieste trattenute (tutte se `n` manca). */
function release(n = held.length): void {
  for (const h of held.splice(0, n)) {
    h.res.setHeader("content-type", "application/json");
    h.res.end(JSON.stringify(textReply("Fatto.")));
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout nell'attesa");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Lo scheduler parte solo dopo startRunQueue (come in index.ts dopo failInterruptedRuns): i test della coda
// lo avviano in beforeEach e lo fermano alla fine di afterEach.
let stopQueue: (() => void) | null = null;

let restoreLoopback: () => void;
beforeAll(() => {
  restoreLoopback = allowTestLoopback();
});

beforeEach(async () => {
  held = [];
  requests = [];
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      held.push({ body, res });
    });
  });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", () => resolve()));
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
});

afterEach(async () => {
  // Nessuna run deve restare in esecuzione nel test successivo
  const open = await db.select({ id: runsTable.id }).from(runsTable);
  for (const r of open) await cancelRun(r.id);
  release();
  await pause(50);
  await scheduleRuns();
  stopQueue?.();
  stopQueue = null;
  vi.restoreAllMocks();
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
});

afterAll(async () => {
  await pool.query("TRUNCATE apps, ai_accounts, users RESTART IDENTITY CASCADE");
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  restoreLoopback();
});

async function seedModel(): Promise<number> {
  const [owner] = await db.insert(usersTable).values({ email: "coda@example.com", name: "Coda" }).returning();
  const [account] = await db
    .insert(aiAccountsTable)
    .values({
      userId: owner!.id,
      name: "Account di prova",
      provider: "custom",
      baseUrl: llmBase,
      allowPrivateNetwork: true,
      apiKeyEnc: encryptSecret("sk-test"),
      status: "ok",
    })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "modello-base", displayName: "Base" })
    .returning();
  return model!.id;
}

/** `count` agenti di area della stessa app, con il modello del finto provider. */
async function seedAgents(count: number): Promise<Agent[]> {
  const modelId = await seedModel();
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "http://mister.example" })
    .returning();
  const agents: Agent[] = [];
  for (let i = 0; i < count; i++) {
    const [agent] = await db
      .insert(agentsTable)
      .values({ appId: app!.id, name: `Area ${i}`, role: "area", status: "active", model: "modello-base", aiModelId: modelId })
      .returning();
    agents.push(agent!);
  }
  return agents;
}

/** Run `pending` scritte direttamente, senza far partire lo scheduler. */
async function insertPending(agent: Agent, count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const [run] = await db
      .insert(runsTable)
      .values({ agentId: agent.id, aiModelId: agent.aiModelId, input: `run ${i}` })
      .returning();
    ids.push(run!.id);
  }
  return ids;
}

async function statuses(): Promise<Map<number, string>> {
  const rows = await db.select({ id: runsTable.id, status: runsTable.status }).from(runsTable).orderBy(asc(runsTable.id));
  return new Map(rows.map((r) => [r.id, r.status]));
}

async function countByStatus(status: string): Promise<number> {
  return [...(await statuses()).values()].filter((s) => s === status).length;
}

describe("createQueuedRun in transazione", () => {
  async function seedTrigger(agent: Agent): Promise<number> {
    const [t] = await db
      .insert(agentTriggersTable)
      .values({ agentId: agent.id, kind: "webhook", name: "hook", secretHash: "h" })
      .returning();
    return t!.id;
  }

  it("transazione annullata → nessuna run; con commit → run con triggerId, senza avviare lo scheduler", async () => {
    const [agent] = await seedAgents(1);
    const triggerId = await seedTrigger(agent!);
    const rollback = new Error("annulla");
    await expect(
      db.transaction(async (tx) => {
        const r = await createQueuedRun({ agent: agent!, input: "x", triggerId, tx });
        expect(r.ok).toBe(true);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.select().from(runsTable)).toHaveLength(0);

    stopQueue = startRunQueue();
    await scheduleRuns(); // il giro iniziale finisce prima della creazione
    const res = await db.transaction((tx) => createQueuedRun({ agent: agent!, input: "x", triggerId, tx }));
    expect(res.ok && res.run.triggerId).toBe(triggerId);
    // scheduleRuns non è stato chiamato: la run resta pending finché non lo fa il chiamante
    await pause(100);
    expect((await db.select().from(runsTable))[0]?.status).toBe("pending");
    expect(held).toHaveLength(0);
  });
});

describe("coda delle run", () => {
  beforeEach(() => {
    stopQueue = startRunQueue();
  });

  it("costanti e messaggi fissi", () => {
    expect(MAX_RUNNING_PER_AGENT).toBe(2);
    expect(MAX_RUNNING_RUNS).toBe(6);
    expect(MAX_PENDING_PER_AGENT).toBe(200);
    expect(RUN_QUEUE_MESSAGES).toEqual({
      queueFull: "troppe run in attesa per questo agente",
      userTokenLost: "token utente perso al riavvio: rilancia la run",
    });
  });

  it("con 5 run dello stesso agente ne partono 2, le altre restano pending; finita una ne parte un'altra in ordine di creazione", async () => {
    const [agent] = await seedAgents(1);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const created = await createQueuedRun({ agent: agent!, input: `run ${i}` });
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(created.run.status).toBe("pending");
        ids.push(created.run.id);
      }
    }
    await waitFor(() => held.length === 2);
    await pause(100);
    expect(held).toHaveLength(2);
    let s = await statuses();
    expect(ids.map((id) => s.get(id))).toEqual(["running", "running", "pending", "pending", "pending"]);

    release(1);
    await waitFor(() => held.length === 2);
    await pause(100);
    s = await statuses();
    expect(s.get(ids[2]!)).toBe("running");
    expect(ids.filter((id) => s.get(id) === "running")).toHaveLength(2);
    expect(s.get(ids[3]!)).toBe("pending");
    expect(s.get(ids[4]!)).toBe("pending");
  });

  it("con 4 agenti da 2 run ciascuno al massimo 6 running in totale", async () => {
    const agents = await seedAgents(4);
    for (const agent of agents) await insertPending(agent, 2);
    await scheduleRuns();
    await waitFor(() => held.length === 6);
    await pause(100);
    expect(held).toHaveLength(6);
    expect(await countByStatus("running")).toBe(6);
    expect(await countByStatus("pending")).toBe(2);

    // Finite tutte, partono anche le ultime due
    release();
    await waitFor(() => held.length === 2);
    release();
    await waitFor(async () => (await countByStatus("succeeded")) === 8);
  });

  it("scheduleRuns chiamata due volte insieme non supera i limiti e non avvia due volte la stessa run", async () => {
    const [agent] = await seedAgents(1);
    const ids = await insertPending(agent!, 5);
    const errors = vi.spyOn(logger, "error");

    await Promise.all([scheduleRuns(), scheduleRuns()]);
    await waitFor(() => held.length === 2);
    await pause(100);
    expect(held).toHaveLength(2);
    expect(await countByStatus("running")).toBe(2);
    expect(await countByStatus("pending")).toBe(3);

    // Altre chiamate sovrapposte mentre le run finiscono una alla volta
    for (let done = 0; done < 5; done++) {
      await waitFor(() => held.length > 0);
      release(1);
      await Promise.all([scheduleRuns(), scheduleRuns(), scheduleRuns()]);
    }
    await waitFor(async () => (await countByStatus("succeeded")) === 5);
    expect(requests).toHaveLength(5);
    for (const id of ids) {
      const steps = await db.select().from(runStepsTable).where(eq(runStepsTable.runId, id));
      expect(steps).toHaveLength(1);
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it("createQueuedRun con 200 pending dell'agente → { ok: false, reason: \"queue_full\" }, nessuna riga inserita", async () => {
    const [agent] = await seedAgents(1);
    await pool.query(
      `insert into runs (agent_id, ai_model_id, status, input) select $1, $2, 'pending', 'x' from generate_series(1, $3::int)`,
      [agent!.id, agent!.aiModelId, MAX_PENDING_PER_AGENT],
    );
    const before = (await db.select({ id: runsTable.id }).from(runsTable)).length;

    const result = await createQueuedRun({ agent: agent!, input: "una di troppo", userToken: "tok" });

    expect(result).toEqual({ ok: false, reason: "queue_full" });
    expect((await db.select({ id: runsTable.id }).from(runsTable)).length).toBe(before);
    // Le run in attesa non vanno eseguite dopo il test
    await pool.query(`update runs set status = 'cancelled'`);
  });

  it("createQueuedRun: modello dell'agente, run madre, has_user_token e token solo in memoria", async () => {
    const [agent] = await seedAgents(1);
    const parent = await insertPending(agent!, 1);
    await pool.query(`update runs set status = 'succeeded' where id = $1`, [parent[0]]);

    const withToken = await createQueuedRun({ agent: agent!, input: "a", parentRunId: parent[0], userToken: "tok-utente" });
    const without = await createQueuedRun({ agent: agent!, input: null });

    expect(withToken.ok && without.ok).toBe(true);
    if (!withToken.ok || !without.ok) return;
    expect(withToken.run).toMatchObject({ aiModelId: agent!.aiModelId, parentRunId: parent[0], hasUserToken: true, input: "a" });
    expect(without.run).toMatchObject({ parentRunId: null, hasUserToken: false, input: null });
    expect(getUserToken(withToken.run.id)).toBe("tok-utente");
    expect(getUserToken(without.run.id)).toBeUndefined();
    const dump = await pool.query("select json_agg(r)::text as runs from runs r");
    expect(dump.rows[0].runs).not.toContain("tok-utente");
  });

  it("una run pending annullata non parte", async () => {
    const [agent] = await seedAgents(1);
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await createQueuedRun({ agent: agent!, input: `run ${i}` });
      if (created.ok) ids.push(created.run.id);
    }
    await waitFor(() => held.length === 2);
    expect((await cancelRun(ids[2]!)).kind).toBe("cancelled");

    release();
    await waitFor(async () => (await countByStatus("succeeded")) === 2);
    await pause(100);
    await scheduleRuns();
    expect((await statuses()).get(ids[2]!)).toBe("cancelled");
    expect(requests).toHaveLength(2);
  });

  it("tetto dell'agente raggiunto dopo il POST: alla partenza failed con il messaggio del tetto e nessuna chiamata al provider", async () => {
    const [agent] = await seedAgents(1);
    // La run è stata accettata (come al POST), poi la spesa del mese supera il tetto
    const [id] = await insertPending(agent!, 1);
    await db.insert(runsTable).values({ agentId: agent!.id, status: "succeeded", costUsd: "5", finishedAt: new Date() });
    await db.update(agentsTable).set({ monthlyBudgetUsd: "1" }).where(eq(agentsTable.id, agent!.id));

    await scheduleRuns();
    await waitFor(async () => (await statuses()).get(id!) === "failed");

    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id!));
    expect(run!.errorMessage).toMatch(/^Tetto di spesa mensile dell'agente raggiunto/);
    expect(run!.errorMessage).not.toContain("Errore durante l'esecuzione");
    expect(requests).toHaveLength(0);
  });

  it("tetto del modello della run raggiunto mentre l'agente è passato a un altro modello: failed col tetto del modello della run, nessuna chiamata", async () => {
    const [agent] = await seedAgents(1);
    // La run è stata accettata con il modello di allora (chi paga resta quello)
    const [id] = await insertPending(agent!, 1);
    const oldModelId = agent!.aiModelId!;
    const [oldModel] = await db.select().from(aiModelsTable).where(eq(aiModelsTable.id, oldModelId));
    const [newModel] = await db
      .insert(aiModelsTable)
      .values({ accountId: oldModel!.accountId, modelId: "modello-nuovo", displayName: "Nuovo" })
      .returning();
    // Poi l'agente cambia modello e il modello della run raggiunge il suo tetto; quello nuovo no
    await db.update(agentsTable).set({ aiModelId: newModel!.id }).where(eq(agentsTable.id, agent!.id));
    await db.update(aiModelsTable).set({ monthlyBudgetUsd: "1" }).where(eq(aiModelsTable.id, oldModelId));
    await db.update(aiModelsTable).set({ monthlyBudgetUsd: "100" }).where(eq(aiModelsTable.id, newModel!.id));
    await db.insert(runsTable).values({ agentId: agent!.id, aiModelId: oldModelId, status: "succeeded", costUsd: "5", finishedAt: new Date() });

    await scheduleRuns();
    await waitFor(async () => (await statuses()).get(id!) === "failed");

    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, id!));
    expect(run!.errorMessage).toMatch(/^Tetto di spesa mensile del modello "Base" raggiunto/);
    expect(requests).toHaveLength(0);
  });

});

describe("avvio dello scheduler", () => {
  it("prima di startRunQueue una run creata resta pending; dopo l'avvio parte", async () => {
    const [agent] = await seedAgents(1);
    const created = await createQueuedRun({ agent: agent!, input: "presto" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await scheduleRuns();
    await pause(100);
    expect((await statuses()).get(created.run.id)).toBe("pending");
    expect(held).toHaveLength(0);

    stopQueue = startRunQueue();
    await waitFor(() => held.length === 1);
    expect((await statuses()).get(created.run.id)).toBe("running");
  });

  it("startRunQueue avvia subito le run in attesa e la funzione restituita ferma il controllo", async () => {
    const [agent] = await seedAgents(1);
    const [id] = await insertPending(agent!, 1);

    stopQueue = startRunQueue();
    await waitFor(() => held.length === 1);
    expect((await statuses()).get(id!)).toBe("running");

    // Fermato lo scheduler, una run nuova resta in attesa
    stopQueue();
    stopQueue = null;
    const [later] = await insertPending(agent!, 1);
    await scheduleRuns();
    await pause(100);
    expect((await statuses()).get(later!)).toBe("pending");
  });
});
