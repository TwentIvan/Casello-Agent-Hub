import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  appsTable,
  localJobsTable,
  localMachinesTable,
  runsTable,
  usersTable,
  type LocalJob,
} from "@workspace/db";
import {
  awaitDispatch,
  chooseForJob,
  claimJob,
  closeMachineJobs,
  completeItem,
  createLocalJob,
  failOpenLocalJobs,
  finishLocalJob,
  heartbeatJob,
  jobByToken,
  nextForMachine,
  reportItemDone,
  runItem,
  setLocalJobTimings,
  touchJob,
  undeliverItem,
} from "./jobs";
import { hashToken } from "./tokens";

// Coda dei lavori dell'agente locale: tempi ridotti (iniettati) per non attendere minuti veri. Il runner è
// simulato con le stesse funzioni usate dalle route /runner (nextForMachine, heartbeatJob, reportItemDone).

const TIMINGS = {
  claimWindowMs: 150,
  heartbeatTimeoutMs: 300,
  waitMs: { analysis: 600, run: 150 },
  postponeMs: 300,
  longPollMs: 200,
};

let restoreTimings: () => void;
let userId: number;
let machineId: number;
let fallbackAiModelId: number;
let runId: number;
let analysisId: number;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jobRow(id: number): Promise<LocalJob> {
  const [row] = await db.select().from(localJobsTable).where(eq(localJobsTable.id, id));
  return row!;
}

async function waitStatus(id: number, status: LocalJob["status"]) {
  for (let i = 0; i < 200; i++) {
    if ((await jobRow(id)).status === status) return;
    await sleep(5);
  }
  throw new Error(`il lavoro ${id} non è arrivato a ${status} (è ${(await jobRow(id)).status})`);
}

async function connect(id = machineId) {
  await db.update(localMachinesTable).set({ lastSeenAt: new Date() }).where(eq(localMachinesTable.id, id));
}

// Attese rimaste aperte (es. runner simulati) si chiudono alla fine di ogni test
let controllers: AbortController[] = [];
function signal() {
  const ac = new AbortController();
  controllers.push(ac);
  return ac.signal;
}

async function newMachine(uid: number, name: string) {
  const [m] = await db.insert(localMachinesTable).values({ userId: uid, name, tokenHash: hashToken(`${name}-${uid}`) }).returning();
  return m!.id;
}

beforeEach(async () => {
  await pool.query("TRUNCATE users, apps, ai_accounts RESTART IDENTITY CASCADE");
  restoreTimings = setLocalJobTimings(TIMINGS);
  const [user] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = user!.id;
  machineId = await newMachine(userId, "MacBook");
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "API", provider: "custom", baseUrl: "https://api.example.com/v1", status: "ok" })
    .returning();
  const [model] = await db.insert(aiModelsTable).values({ accountId: account!.id, modelId: "m", displayName: "m" }).returning();
  fallbackAiModelId = model!.id;
  const [app] = await db.insert(appsTable).values({ name: "App", slug: "app", baseUrl: "https://app.example.com" }).returning();
  const [agent] = await db.insert(agentsTable).values({ appId: app!.id, name: "Agente" }).returning();
  const [run] = await db.insert(runsTable).values({ agentId: agent!.id, input: "ciao" }).returning();
  runId = run!.id;
  const [analysis] = await db
    .insert(analysesTable)
    .values({ appId: app!.id, model: "m", sources: {} as never, maxTokens: 1000 })
    .returning();
  analysisId = analysis!.id;
});

afterEach(() => {
  for (const ac of controllers) ac.abort();
  controllers = [];
  restoreTimings();
});

function runJob(extra: Partial<Parameters<typeof createLocalJob>[0]> = {}) {
  return createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId, origin: "console", ...extra });
}

function analysisJob(extra: Partial<Parameters<typeof createLocalJob>[0]> = {}) {
  return createLocalJob({ userId, machineId, kind: "analysis", analysisId, fallbackAiModelId, origin: "console", ...extra });
}

describe("createLocalJob", () => {
  it("tipo e riferimento devono corrispondere (uno solo)", async () => {
    await expect(createLocalJob({ userId, machineId, kind: "run", analysisId, fallbackAiModelId, origin: "console" })).rejects.toThrow();
    await expect(createLocalJob({ userId, machineId, kind: "analysis", runId, fallbackAiModelId, origin: "console" })).rejects.toThrow();
    await expect(
      createLocalJob({ userId, machineId, kind: "run", runId, analysisId, fallbackAiModelId, origin: "console" }),
    ).rejects.toThrow();
    const job = await runJob();
    expect(job).toMatchObject({ status: "queued", kind: "run", runId, analysisId: null, origin: "console" });
  });

  it("macchina di un altro utente o revocata → rifiutata", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const otherMachine = await newMachine(other!.id, "PC");
    await expect(runJob({ machineId: otherMachine })).rejects.toThrow();
    await db.update(localMachinesTable).set({ revokedAt: new Date() }).where(eq(localMachinesTable.id, machineId));
    await expect(runJob()).rejects.toThrow();
  });
});

describe("awaitDispatch", () => {
  it("runner collegato: lo prende e il compito arriva al runner; done → runItem risolve", async () => {
    await connect();
    const job = await analysisJob();
    const runner = nextForMachine(machineId, signal());
    const outcome = await awaitDispatch(job.id, signal());
    expect(outcome).toEqual({ kind: "local" });
    expect(await jobRow(job.id)).toMatchObject({ status: "claimed", claimedBy: "runner" });

    const item = runItem(job.id, { prompt: "Analizza", resume: false }, signal());
    const delivery = await runner;
    expect(delivery).toMatchObject({ jobId: job.id, prompt: "Analizza", resumeSessionId: null });
    expect(delivery!.jobToken).toMatch(/^csl_j_/);
    expect((await jobByToken(delivery!.jobToken))?.id).toBe(job.id);
    expect(await jobRow(job.id)).toMatchObject({ status: "running", jobTokenHash: hashToken(delivery!.jobToken) });

    await reportItemDone(machineId, delivery!.itemId, { sessionId: "sess-1", exit: "done", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(await item).toEqual({ sessionId: "sess-1", exit: "done", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(await jobRow(job.id)).toMatchObject({ status: "claimed", claudeSessionId: "sess-1", currentItem: null });
  });

  it("runner collegato ma la presa non arriva entro la finestra: console → waiting_choice", async () => {
    await connect();
    const job = await runJob();
    const outcome = awaitDispatch(job.id, signal());
    await sleep(80);
    expect((await jobRow(job.id)).status).toBe("queued");
    await waitStatus(job.id, "waiting_choice");
    await chooseForJob(job.id, userId, "fallback");
    expect(await outcome).toEqual({ kind: "fallback", aiModelId: fallbackAiModelId });
  });

  it("nessun runner, console: waiting_choice e scelta del modello di riserva", async () => {
    const job = await runJob();
    const outcome = awaitDispatch(job.id, signal());
    await waitStatus(job.id, "waiting_choice");
    await chooseForJob(job.id, userId, "fallback");
    expect(await outcome).toEqual({ kind: "fallback", aiModelId: fallbackAiModelId });
  });

  it("posticipa: parte al collegamento successivo del runner", async () => {
    const job = await analysisJob();
    const outcome = awaitDispatch(job.id, signal());
    await waitStatus(job.id, "waiting_choice");
    await chooseForJob(job.id, userId, "postpone");
    expect((await jobRow(job.id)).status).toBe("postponed");
    const runner = nextForMachine(machineId, signal());
    expect(await outcome).toEqual({ kind: "local" });
    const item = runItem(job.id, { prompt: "p", resume: false }, signal());
    const delivery = await runner;
    expect(delivery?.prompt).toBe("p");
    await reportItemDone(machineId, delivery!.itemId, { sessionId: null, exit: "error", usage: null });
    expect(await item).toEqual({ sessionId: null, exit: "error", usage: null });
  });

  it("posticipa senza runner: dopo il tempo massimo (24 h) cancelled", async () => {
    const job = await analysisJob();
    const outcome = awaitDispatch(job.id, signal());
    await waitStatus(job.id, "waiting_choice");
    await chooseForJob(job.id, userId, "postpone");
    expect(await outcome).toEqual({ kind: "cancelled", error: "agente locale non collegato" });
    expect(await jobRow(job.id)).toMatchObject({ status: "cancelled", error: "agente locale non collegato" });
  });

  it("attendi: una run scade dopo il suo tempo, un'analisi resiste di più", async () => {
    const run = await runJob();
    const analysis = await analysisJob();
    const runOutcome = awaitDispatch(run.id, signal());
    const analysisOutcome = awaitDispatch(analysis.id, signal());
    await waitStatus(run.id, "waiting_choice");
    await waitStatus(analysis.id, "waiting_choice");
    await chooseForJob(run.id, userId, "wait");
    await chooseForJob(analysis.id, userId, "wait");
    expect((await jobRow(run.id)).status).toBe("queued");
    expect(await runOutcome).toEqual({ kind: "cancelled", error: "agente locale non collegato" });
    expect(await jobRow(run.id)).toMatchObject({ status: "failed", error: "agente locale non collegato" });
    expect((await jobRow(analysis.id)).status).toBe("queued");
    expect(await analysisOutcome).toEqual({ kind: "cancelled", error: "agente locale non collegato" });
    expect((await jobRow(analysis.id)).status).toBe("failed");
  });

  it("nessuna scelta dalla console: allo scadere della finestra failed", async () => {
    const job = await runJob();
    expect(await awaitDispatch(job.id, signal())).toEqual({ kind: "cancelled", error: "agente locale non collegato" });
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "agente locale non collegato" });
  });

  it("attendi e poi il runner si collega: local", async () => {
    const job = await analysisJob();
    const outcome = awaitDispatch(job.id, signal());
    await waitStatus(job.id, "waiting_choice");
    await chooseForJob(job.id, userId, "wait");
    void nextForMachine(machineId, signal());
    expect(await outcome).toEqual({ kind: "local" });
  });

  it("app, regola fallback (default): riserva subito", async () => {
    const job = await runJob({ origin: "app" });
    expect(await awaitDispatch(job.id, signal())).toEqual({ kind: "fallback", aiModelId: fallbackAiModelId });
    const explicit = await runJob({ origin: "app", policy: { kind: "fallback", waitS: 30 } });
    expect(await awaitDispatch(explicit.id, signal())).toEqual({ kind: "fallback", aiModelId: fallbackAiModelId });
  });

  it("app, wait_then_fallback: attende waitS e poi riserva; se il runner arriva prima, local", async () => {
    const job = await runJob({ origin: "app", policy: { kind: "wait_then_fallback", waitS: 1 } });
    const started = Date.now();
    const outcome = awaitDispatch(job.id, signal());
    await sleep(300);
    expect((await jobRow(job.id)).status).toBe("queued");
    expect(await outcome).toEqual({ kind: "fallback", aiModelId: fallbackAiModelId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);

    const second = await runJob({ origin: "app", policy: { kind: "wait_then_fallback", waitS: 1 } });
    const secondOutcome = awaitDispatch(second.id, signal());
    await sleep(50);
    void nextForMachine(machineId, signal());
    expect(await secondOutcome).toEqual({ kind: "local" });
  });

  it("app, postpone: postponed, poi cancelled dopo il tempo massimo", async () => {
    const job = await runJob({ origin: "app", policy: { kind: "postpone", waitS: 30 } });
    const outcome = awaitDispatch(job.id, signal());
    await waitStatus(job.id, "postponed");
    expect(await outcome).toEqual({ kind: "cancelled", error: "agente locale non collegato" });
    expect((await jobRow(job.id)).status).toBe("cancelled");
  });

  it("senza modello di riserva la regola fallback annulla il lavoro", async () => {
    const job = await createLocalJob({ userId, machineId, kind: "run", runId, fallbackAiModelId: fallbackAiModelId, origin: "app" });
    await db.update(localJobsTable).set({ fallbackAiModelId: null }).where(eq(localJobsTable.id, job.id));
    expect(await awaitDispatch(job.id, signal())).toEqual({
      kind: "cancelled",
      error: "modello di riserva obbligatorio con l'agente locale",
    });
  });

  it("segnale annullato: il lavoro diventa cancelled", async () => {
    const job = await runJob();
    const ac = new AbortController();
    const outcome = awaitDispatch(job.id, ac.signal);
    await waitStatus(job.id, "waiting_choice");
    ac.abort();
    expect(await outcome).toEqual({ kind: "cancelled", error: "lavoro annullato" });
    expect((await jobRow(job.id)).status).toBe("cancelled");
  });
});

describe("chooseForJob", () => {
  it("lavoro altrui → lavoro non trovato; lavoro non in attesa di scelta → rifiutato", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const job = await runJob();
    await expect(chooseForJob(job.id, other!.id, "fallback")).rejects.toThrow("lavoro non trovato");
    await expect(chooseForJob(job.id, userId, "fallback")).rejects.toThrow("il lavoro non è in attesa di una scelta");
  });
});

describe("runItem e segnale di vita", () => {
  async function runningJob() {
    await connect();
    const job = await runJob();
    const runner = nextForMachine(machineId, signal());
    expect(await awaitDispatch(job.id, signal())).toEqual({ kind: "local" });
    const item = runItem(job.id, { prompt: "p", resume: false }, signal());
    // Gestito anche se il test non lo attende (l'afterEach annulla le attese rimaste)
    item.catch(() => {});
    const delivery = (await runner)!;
    return { job, item, delivery };
  }

  it("senza segnale di vita per il tempo limite: 'agente locale disconnesso', una volta sola", async () => {
    const { job, item, delivery } = await runningJob();
    const started = Date.now();
    await expect(item).rejects.toThrow("agente locale disconnesso");
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMINGS.heartbeatTimeoutMs - 50);
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "agente locale disconnesso" });
    // Il runner che torna dopo trova il lavoro scaduto
    await expect(heartbeatJob(machineId, job.id)).rejects.toThrow("lavoro scaduto");
    await expect(reportItemDone(machineId, delivery.itemId, { sessionId: "s", exit: "done", usage: null })).rejects.toThrow("lavoro scaduto");
  });

  it("il segnale di vita torna prima del limite: il compito prosegue", async () => {
    const { job, item, delivery } = await runningJob();
    await sleep(TIMINGS.heartbeatTimeoutMs - 100);
    await heartbeatJob(machineId, job.id);
    await sleep(TIMINGS.heartbeatTimeoutMs - 100);
    await heartbeatJob(machineId, job.id);
    await sleep(TIMINGS.heartbeatTimeoutMs - 100);
    await reportItemDone(machineId, delivery.itemId, { sessionId: "s2", exit: "done", usage: null });
    expect(await item).toEqual({ sessionId: "s2", exit: "done", usage: null });
    expect((await jobRow(job.id)).status).toBe("claimed");
  });

  it("completamento dal consumatore prima del done: runItem risolve; il done successivo salva la sessione", async () => {
    const { job, item, delivery } = await runningJob();
    expect(await completeItem(job.id, delivery.itemId, { fase: "ok" })).toBe(true);
    expect(await item).toEqual({ sessionId: null, exit: "done", usage: null, completion: { fase: "ok" } });
    expect(await completeItem(job.id, delivery.itemId, {})).toBe(false);
    await reportItemDone(machineId, delivery.itemId, { sessionId: "s3", exit: "done", usage: null });
    expect(await jobRow(job.id)).toMatchObject({ claudeSessionId: "s3", currentItem: null, status: "claimed" });
  });

  it("resume: il compito successivo riceve la sessione scritta dal done precedente", async () => {
    const { job, item, delivery } = await runningJob();
    await reportItemDone(machineId, delivery.itemId, { sessionId: "s1", exit: "done", usage: null });
    await item;
    const runner = nextForMachine(machineId, signal());
    void runItem(job.id, { prompt: "correggi", resume: true }, signal()).catch(() => {});
    expect(await runner).toMatchObject({ prompt: "correggi", resumeSessionId: "s1" });
  });

  it("resume dopo un completamento arrivato prima del done: la sessione arriva comunque", async () => {
    const { job, item, delivery } = await runningJob();
    expect(await completeItem(job.id, delivery.itemId, "ok")).toBe(true);
    await item;
    // Il consumatore pubblica subito il compito seguente; il done del primo arriva dopo
    const second = runItem(job.id, { prompt: "fase 2", resume: true }, signal());
    second.catch(() => {});
    await reportItemDone(machineId, delivery.itemId, { sessionId: "s-tardiva", exit: "done", usage: null });
    expect((await jobRow(job.id)).claudeSessionId).toBe("s-tardiva");
    const next = await nextForMachine(machineId, signal());
    expect(next).toMatchObject({ prompt: "fase 2", resumeSessionId: "s-tardiva" });
    // Senza resume la sessione non si passa
    await reportItemDone(machineId, next!.itemId, { sessionId: "s-2", exit: "done", usage: null });
    await second;
    const runner = nextForMachine(machineId, signal());
    void runItem(job.id, { prompt: "nuova", resume: false }, signal()).catch(() => {});
    expect(await runner).toMatchObject({ prompt: "nuova", resumeSessionId: null });
  });

  it("ripresa con il compito precedente ancora in corso sul runner: consegnata solo dopo il suo done, con la sessione", async () => {
    const { job, item, delivery } = await runningJob();
    expect(await completeItem(job.id, delivery.itemId, "pausa")).toBe(true);
    await item;
    const second = runItem(job.id, { prompt: "ripresa", resume: true }, signal());
    second.catch(() => {});
    // Un altro posto del runner chiede lavoro: la ripresa non parte senza la sessione del compito precedente
    let delivered: Awaited<ReturnType<typeof nextForMachine>> | undefined;
    const next = nextForMachine(machineId, signal()).then((d) => (delivered = d));
    await sleep(80);
    expect(delivered).toBeUndefined();
    await reportItemDone(machineId, delivery.itemId, { sessionId: "s-prima", exit: "done", usage: null });
    await next;
    expect(delivered).toMatchObject({ prompt: "ripresa", resumeSessionId: "s-prima" });
  });

  it("ripresa senza una sessione da riprendere: il lavoro fallisce con il messaggio fisso (mai una sessione vuota)", async () => {
    const { job, item, delivery } = await runningJob();
    await reportItemDone(machineId, delivery.itemId, { sessionId: null, exit: "error", usage: null });
    await item;
    const second = runItem(job.id, { prompt: "correggi", resume: true }, signal());
    second.catch(() => {});
    expect(await nextForMachine(machineId, signal())).toBeNull();
    await expect(second).rejects.toThrow("sessione di Claude Code da riprendere non disponibile");
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "sessione di Claude Code da riprendere non disponibile" });
  });

  it("consegna persa: il compito torna in attesa e arriva alla richiesta seguente con un token nuovo", async () => {
    const { job, delivery } = await runningJob();
    await undeliverItem(job.id, delivery.itemId);
    expect((await jobRow(job.id)).status).toBe("claimed");
    const again = await nextForMachine(machineId, signal());
    expect(again).toMatchObject({ jobId: job.id, itemId: delivery.itemId, prompt: "p" });
    expect(again!.jobToken).not.toBe(delivery.jobToken);
    expect(await jobByToken(delivery.jobToken)).toBeNull();
    expect((await jobByToken(again!.jobToken))?.id).toBe(job.id);
  });

  it("il segnale di vita rinnova la scadenza del token (runner e chat)", async () => {
    const { job } = await runningJob();
    const soon = new Date(Date.now() + 1000);
    await db.update(localJobsTable).set({ jobTokenExpiresAt: soon }).where(eq(localJobsTable.id, job.id));
    await heartbeatJob(machineId, job.id);
    expect((await jobRow(job.id)).jobTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);

    const chat = await analysisJob();
    await claimJob(chat.id, { by: "chat", userId });
    await db.update(localJobsTable).set({ jobTokenExpiresAt: soon }).where(eq(localJobsTable.id, chat.id));
    await touchJob(chat.id);
    expect((await jobRow(chat.id)).jobTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("modalità chat: nessun controllo del segnale di vita, il compito finisce con completeItem", async () => {
    const job = await runJob();
    const outcome = awaitDispatch(job.id, signal());
    await waitStatus(job.id, "waiting_choice");
    const { jobToken } = await claimJob(job.id, { by: "chat", userId });
    expect(await outcome).toEqual({ kind: "local" });
    const item = runItem(job.id, { prompt: "chat", resume: false }, signal());
    await waitStatus(job.id, "running");
    const live = await jobByToken(jobToken);
    expect(live?.currentItem).toMatchObject({ prompt: "chat" });
    await sleep(TIMINGS.heartbeatTimeoutMs + 100);
    await touchJob(job.id);
    expect(await completeItem(job.id, live!.currentItem!.id, "fine")).toBe(true);
    expect(await item).toMatchObject({ exit: "done", completion: "fine" });
    expect(await jobRow(job.id)).toMatchObject({ status: "claimed", currentItem: null });
  });

  it("due prese concorrenti (runner e chat): una sola vince, l'altra riceve 'lavoro non trovato'", async () => {
    const job = await runJob();
    const results = await Promise.allSettled([
      claimJob(job.id, { by: "runner", machineId }),
      claimJob(job.id, { by: "chat", userId }),
      claimJob(job.id, { by: "runner", machineId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason.message).toBe("lavoro non trovato");
    }
  });

  it("presa di un lavoro altrui → lavoro non trovato", async () => {
    const [other] = await db.insert(usersTable).values({ email: "altro@example.com" }).returning();
    const otherMachine = await newMachine(other!.id, "PC");
    const job = await runJob();
    await expect(claimJob(job.id, { by: "chat", userId: other!.id })).rejects.toThrow("lavoro non trovato");
    await expect(claimJob(job.id, { by: "runner", machineId: otherMachine })).rejects.toThrow("lavoro non trovato");
  });
});

describe("chiusura dei lavori", () => {
  it("failOpenLocalJobs: aperti → failed 'interrotto dal riavvio'; il runner non riprende il compito orfano", async () => {
    await connect();
    const job = await runJob();
    const runner = nextForMachine(machineId, signal());
    expect(await awaitDispatch(job.id, signal())).toEqual({ kind: "local" });
    const item = runItem(job.id, { prompt: "p", resume: false }, signal());
    const delivery = (await runner)!;
    const queued = await analysisJob();
    const done = await runJob();
    await finishLocalJob(done.id, "completed");

    expect(await failOpenLocalJobs()).toBe(2);
    await expect(item).rejects.toThrow("interrotto dal riavvio");
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "interrotto dal riavvio" });
    expect(await jobRow(queued.id)).toMatchObject({ status: "failed", error: "interrotto dal riavvio" });
    expect((await jobRow(done.id)).status).toBe("completed");

    expect(await jobByToken(delivery.jobToken)).toBeNull();
    await expect(heartbeatJob(machineId, job.id)).rejects.toThrow("lavoro scaduto");
    await expect(reportItemDone(machineId, delivery.itemId, { sessionId: "x", exit: "done", usage: null })).rejects.toThrow("lavoro scaduto");
    expect(await nextForMachine(machineId, signal())).toBeNull();
  });

  it("jobByToken: token non di lavoro, sconosciuto o di un lavoro chiuso → null", async () => {
    const job = await runJob();
    const { jobToken } = await claimJob(job.id, { by: "chat", userId });
    expect((await jobByToken(jobToken))?.id).toBe(job.id);
    expect(await jobByToken("csl_j_" + "a".repeat(43))).toBeNull();
    expect(await jobByToken(jobToken.replace("csl_j_", "csl_m_"))).toBeNull();
    await finishLocalJob(job.id, "completed");
    expect(await jobByToken(jobToken)).toBeNull();
  });

  it("jobByToken: macchina revocata → null anche con il lavoro ancora aperto", async () => {
    const job = await runJob();
    const { jobToken } = await claimJob(job.id, { by: "runner", machineId });
    expect((await jobByToken(jobToken))?.id).toBe(job.id);
    await db.update(localMachinesTable).set({ revokedAt: new Date() }).where(eq(localMachinesTable.id, machineId));
    expect(await jobByToken(jobToken)).toBeNull();
  });

  it("closeMachineJobs: tutti gli aperti della macchina → failed 'macchina non disponibile'; runItem e awaitDispatch si svegliano", async () => {
    await connect();
    const job = await runJob();
    const runner = nextForMachine(machineId, signal());
    expect(await awaitDispatch(job.id, signal())).toEqual({ kind: "local" });
    const item = runItem(job.id, { prompt: "p", resume: false }, signal());
    const delivery = (await runner)!;
    // Un lavoro non ancora preso, in attesa della scelta della console
    await db.update(localMachinesTable).set({ lastSeenAt: null }).where(eq(localMachinesTable.id, machineId));
    const waiting = await analysisJob();
    const dispatch = awaitDispatch(waiting.id, signal());
    await waitStatus(waiting.id, "waiting_choice");
    const done = await runJob();
    await finishLocalJob(done.id, "completed");
    const otherMachine = await newMachine(userId, "PC");
    const other = await runJob({ machineId: otherMachine });

    const closed = await closeMachineJobs(machineId);

    expect(closed.map((j) => j.id).sort()).toEqual([job.id, waiting.id].sort());
    await expect(item).rejects.toThrow("macchina non disponibile");
    expect(await dispatch).toEqual({ kind: "cancelled", error: "macchina non disponibile" });
    expect(await jobRow(job.id)).toMatchObject({ status: "failed", error: "macchina non disponibile" });
    expect(await jobRow(waiting.id)).toMatchObject({ status: "failed", error: "macchina non disponibile" });
    expect((await jobRow(done.id)).status).toBe("completed");
    expect((await jobRow(other.id)).status).toBe("queued");
    expect(await jobByToken(delivery.jobToken)).toBeNull();
  });

  it("jobByToken: token scaduto → null", async () => {
    const job = await runJob();
    const { jobToken } = await claimJob(job.id, { by: "chat", userId });
    await db.update(localJobsTable).set({ jobTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(localJobsTable.id, job.id));
    expect(await jobByToken(jobToken)).toBeNull();
  });
});
