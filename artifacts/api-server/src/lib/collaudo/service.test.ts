import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  appsTable,
  db,
  pendingActionsTable,
  pool,
  releaseTestFilesTable,
  releaseTestsTable,
  teamEventsTable,
  teamInstancesTable,
  teamTurnsTable,
  teamWorksTable,
} from "@workspace/db";
import { ensureUser } from "../../../test/team-node-fixture";
import { enqueueReleaseItem } from "../actions/queue";
import { requireCollaudoToken } from "./auth";
import { COLLAUDO_MESSAGES } from "./messages";
import { report } from "./protocol";
import { finishReleaseTest, onTestClaimed, onTestReported, requestReleaseTest, scheduleReleaseTests, sweepReleaseTests } from "./service";
import { hashSecret } from "./tokens";

// Ciclo di vita del collaudo: lancio con limiti, annullamento, controllo periodico e correzione automatica (PGlite; lancio del
// workflow e modello finti).

const dispatched: number[] = [];
vi.mock("./dispatch", () => ({
  dispatchTest: vi.fn(async (testId: number) => {
    dispatched.push(testId);
    return { ok: true };
  }),
}));
const modelMock = vi.hoisted(() => ({ skip: null as string | null }));
vi.mock("./model", () => ({
  testModelFor: vi.fn(async () => (modelMock.skip ? { skip: modelMock.skip } : { aiModelId: 1, resolved: {} })),
}));

// Collaudatore finto: in «deliver» scrive l'esito e finisce, in «wait» resta acceso finché il segnale non lo ferma
const agentMock = vi.hoisted(() => ({
  mode: "deliver" as "deliver" | "wait",
  outcome: "problems" as "ok" | "problems",
  calls: [] as { testId: number; signal: AbortSignal | undefined }[],
}));
vi.mock("./run-test", async () => {
  const { db: database, releaseTestsTable: table } = await import("@workspace/db");
  const { eq: equals } = await import("drizzle-orm");
  return {
    runReleaseTest: vi.fn(async (testId: number, signal?: AbortSignal) => {
      agentMock.calls.push({ testId, signal });
      if (agentMock.mode === "wait") {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return;
      }
      await database.update(table).set({ outcome: agentMock.outcome, report: "Resoconto dell'agente" }).where(equals(table.id, testId));
    }),
  };
});

const savedRepo = process.env["COLLAUDO_REPO"];
const savedKey = process.env["CASELLO_SECRET_KEY"];
let userId: number;

const testRow = async (id: number) => (await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, id)))[0]!;
const workRow = async (id: number) => (await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, id)))[0]!;

/** App con squadra attiva e lavoro in attesa di «Porta in produzione» con la sua voce `release`. */
async function seedWork(slug: string, opts: { autoFix?: boolean; headSha?: string } = {}) {
  const [app] = await db
    .insert(appsTable)
    .values({ name: slug, slug, baseUrl: `https://${slug}.example.com`, sourceType: "github", sourceRepo: `ivan/${slug}`, sourceInstallationId: 7, testAutoFix: opts.autoFix ?? false })
    .returning();
  const [instance] = await db
    .insert(teamInstancesTable)
    .values({ name: `Squadra ${slug}`, refAppId: app!.id, refType: "piano", refId: "1", refTitle: "Piano", roles: [], status: "active", createdBy: userId, activatedBy: userId })
    .returning();
  const queued = await enqueueReleaseItem({ userId, instanceId: instance!.id, recipient: `ivan/${slug}`, summary: "Porta in produzione il lavoro 1", detail: {} });
  if (!queued.ok) throw new Error("voce non accodata");
  const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, queued.number));
  const [work] = await db
    .insert(teamWorksTable)
    .values({
      instanceId: instance!.id,
      number: 1,
      repo: `ivan/${slug}`,
      branch: `botcave/lavoro-${instance!.id}-1`,
      baseBranch: "main",
      baseSha: "abc1234",
      headSha: opts.headSha ?? "def5678",
      status: "awaiting_release",
      pendingActionId: item!.id,
    })
    .returning();
  return { appId: app!.id, instanceId: instance!.id, workId: work!.id, itemId: item!.id };
}

/** Collaudo consegnato dall'agente con l'esito dato. */
async function delivered(workId: number, outcome: "ok" | "problems" | "not_startable") {
  const id = (await requestReleaseTest(workId))!;
  await scheduleReleaseTests();
  await db.update(releaseTestsTable).set({ status: "running", outcome, report: `Resoconto ${outcome}` }).where(eq(releaseTestsTable.id, id));
  return id;
}

beforeEach(async () => {
  process.env["COLLAUDO_REPO"] = "ivan/collaudo";
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  dispatched.length = 0;
  agentMock.mode = "deliver";
  agentMock.outcome = "problems";
  agentMock.calls.length = 0;
  modelMock.skip = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
  userId = await ensureUser("collaudo@example.com");
});

afterEach(async () => {
  // Nessun lancio in background lasciato a metà tra un test e l'altro
  await scheduleReleaseTests();
});

afterAll(async () => {
  if (savedRepo === undefined) delete process.env["COLLAUDO_REPO"];
  else process.env["COLLAUDO_REPO"] = savedRepo;
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE users, apps, team_instances RESTART IDENTITY CASCADE");
});

describe("ciclo di vita del collaudo", () => {
  it("scheduler rispetta i limiti e lancia una volta", async () => {
    const ids: number[] = [];
    for (const slug of ["uno", "due", "tre", "quattro"]) {
      const { workId } = await seedWork(slug);
      ids.push((await requestReleaseTest(workId))!);
    }
    await Promise.all([scheduleReleaseTests(), scheduleReleaseTests()]);
    expect(dispatched).toHaveLength(3);
    expect(new Set(dispatched).size).toBe(3);
    const rows = await Promise.all(ids.map(testRow));
    expect(rows.filter((r) => r.status === "dispatching")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(rows.every((r) => r.codeHash === null || r.status === "dispatching")).toBe(true);

    // Il primo finisce: parte il quarto, una volta sola
    const first = dispatched[0]!;
    await db.update(releaseTestsTable).set({ status: "running", outcome: "ok" }).where(eq(releaseTestsTable.id, first));
    await report(first, "done");
    onTestReported(first);
    await Promise.all([scheduleReleaseTests(), scheduleReleaseTests()]);
    expect((await testRow(first)).status).toBe("done");
    expect(dispatched).toHaveLength(4);
    expect(new Set(dispatched)).toEqual(new Set(ids));
  });

  it("idempotente per lavoro, testa e modo", async () => {
    const { workId } = await seedWork("idem");
    const a = await requestReleaseTest(workId);
    const b = await requestReleaseTest(workId);
    expect(b).toBe(a);
  });

  it("modello non usabile: saltato senza lanciare il runner", async () => {
    modelMock.skip = COLLAUDO_MESSAGES.noModel;
    const { workId } = await seedWork("senza-modello");
    const id = (await requestReleaseTest(workId))!;
    await scheduleReleaseTests();
    const row = await testRow(id);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe(COLLAUDO_MESSAGES.noModel);
    expect(dispatched).toEqual([]);
  });

  it("codice scaduto chiude il collaudo", async () => {
    const { workId } = await seedWork("scaduto");
    const id = (await requestReleaseTest(workId))!;
    await scheduleReleaseTests();
    expect((await testRow(id)).status).toBe("dispatching");
    await sweepReleaseTests(new Date(Date.now() + 16 * 60_000));
    const row = await testRow(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(COLLAUDO_MESSAGES.runnerNotStarted);
    expect(row.codeHash).toBeNull();
  });

  it("lease e token scaduti: interrotto e tempo scaduto; file vecchi cancellati", async () => {
    const one = await seedWork("lease");
    const two = await seedWork("token");
    const leaseId = (await requestReleaseTest(one.workId))!;
    const tokenId = (await requestReleaseTest(two.workId))!;
    await scheduleReleaseTests();
    const now = Date.now();
    await db
      .update(releaseTestsTable)
      .set({ status: "running", tokenHash: "x", tokenExpiresAt: new Date(now + 60 * 60_000), leaseExpiresAt: new Date(now - 1_000) })
      .where(eq(releaseTestsTable.id, leaseId));
    await db
      .update(releaseTestsTable)
      .set({ status: "running", tokenHash: "y", tokenExpiresAt: new Date(now - 1_000), leaseExpiresAt: new Date(now + 60_000) })
      .where(eq(releaseTestsTable.id, tokenId));
    await db.insert(releaseTestFilesTable).values([
      { testId: leaseId, kind: "screenshot", name: "vecchio.png", contentType: "image/png", size: 1, sha256: "a", content: Buffer.from([1]), createdAt: new Date(now - 31 * 24 * 60 * 60_000) },
      { testId: leaseId, kind: "screenshot", name: "nuovo.png", contentType: "image/png", size: 1, sha256: "b", content: Buffer.from([1]) },
    ]);
    await sweepReleaseTests(new Date(now));
    const lease = await testRow(leaseId);
    expect(lease.status).toBe("failed");
    expect(lease.error).toBe(COLLAUDO_MESSAGES.interrupted);
    expect(lease.tokenHash).toBeNull();
    const token = await testRow(tokenId);
    expect(token.status).toBe("failed");
    expect(token.error).toBe(COLLAUDO_MESSAGES.timeout);
    const files = await db.select({ name: releaseTestFilesTable.name }).from(releaseTestFilesTable);
    expect(files.map((f) => f.name)).toEqual(["nuovo.png"]);
  });

  it("relight non annulla un collaudo full aperto: null e il collaudo resta", async () => {
    const { workId } = await seedWork("relight-full");
    const fullId = (await requestReleaseTest(workId))!;
    expect(await requestReleaseTest(workId, "relight")).toBeNull();
    expect((await testRow(fullId)).status).not.toBe("cancelled");
    expect(await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.workId, workId))).toHaveLength(1);
  });

  it("relight su un relight aperto lo sostituisce", async () => {
    const { workId } = await seedWork("relight-relight");
    const first = (await requestReleaseTest(workId, "relight"))!;
    await db.update(teamWorksTable).set({ headSha: "fff9999" }).where(eq(teamWorksTable.id, workId));
    const second = (await requestReleaseTest(workId, "relight"))!;
    expect(second).not.toBe(first);
    expect((await testRow(first)).status).toBe("cancelled");
    expect((await testRow(second)).sha).toBe("fff9999");
  });

  it("nuovo collaudo annulla il precedente", async () => {
    const { workId } = await seedWork("annulla");
    const oldId = (await requestReleaseTest(workId))!;
    await scheduleReleaseTests();
    const token = "ctk_tokendelcollaudoannullato";
    await db
      .update(releaseTestsTable)
      .set({ status: "running", tokenHash: hashSecret(token), tokenExpiresAt: new Date(Date.now() + 60 * 60_000), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(releaseTestsTable.id, oldId));
    await db.update(teamWorksTable).set({ headSha: "fff9999" }).where(eq(teamWorksTable.id, workId));

    const newId = (await requestReleaseTest(workId))!;
    expect(newId).not.toBe(oldId);
    const old = await testRow(oldId);
    expect(old.status).toBe("cancelled");
    expect(old.tokenHash).toBeNull();
    expect((await testRow(newId)).sha).toBe("fff9999");

    // La `next` del runner del vecchio collaudo riceve 401
    const res = { statusCode: 0, status(code: number) { this.statusCode = code; return this; }, json() { return this; } };
    const next = vi.fn();
    await requireCollaudoToken({ headers: { authorization: `Bearer ${token}` }, get: () => undefined } as never, res as never, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("senza COLLAUDO_REPO: saltato «non configurato»", async () => {
    delete process.env["COLLAUDO_REPO"];
    const { workId } = await seedWork("nonconf");
    const id = (await requestReleaseTest(workId))!;
    const row = await testRow(id);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe(COLLAUDO_MESSAGES.notConfigured);
    expect(dispatched).toEqual([]);
  });

  it("report done senza consegna dell'agente: non consegnato", async () => {
    const { workId } = await seedWork("vuoto");
    const id = (await requestReleaseTest(workId))!;
    await scheduleReleaseTests();
    await db.update(releaseTestsTable).set({ status: "running" }).where(eq(releaseTestsTable.id, id));
    await report(id, "done");
    const row = await testRow(id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(COLLAUDO_MESSAGES.notDelivered);
  });
});

describe("correzione automatica", () => {
  it("esito problems con «Correggi da solo»: voce rifiutata, lavoro aperto, turno del capo; al terzo la voce resta", async () => {
    const { workId, itemId, instanceId } = await seedWork("fix", { autoFix: true });
    for (let round = 1; round <= 2; round++) {
      const id = await delivered(workId, "problems");
      await finishReleaseTest(id);
      const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, round === 1 ? itemId : (await workRow(workId)).pendingActionId ?? -1));
      const work = await workRow(workId);
      expect(work.status).toBe("open");
      expect(work.testAutoRejects).toBe(round);
      expect(work.rejectionNote).toBe("Resoconto problems");
      if (round === 1) {
        expect(item!.status).toBe("rejected");
        expect(item!.decisionNote).toBe("Resoconto problems");
      }
      const [turn] = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
      const reasons = JSON.stringify(turn!.reasons);
      expect(reasons).toContain(COLLAUDO_MESSAGES.autoRejectTurn(1, "Resoconto problems"));
      expect(reasons).not.toContain("L'utente");
      await report(id, "done");
      // Nuova voce: il lavoro torna in attesa di «Porta in produzione»
      const queued = await enqueueReleaseItem({ userId, instanceId, recipient: "ivan/fix", summary: "Porta in produzione", detail: {} });
      if (!queued.ok) throw new Error("voce non accodata");
      const [next] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, queued.number));
      await db.update(teamWorksTable).set({ status: "awaiting_release", pendingActionId: next!.id, headSha: `abc000${round}` }).where(eq(teamWorksTable.id, workId));
    }
    const events = await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId));
    expect(events.filter((e) => e.bulletin === "Collaudo del lavoro 1: problemi, rimandato alla squadra")).toHaveLength(2);

    // Terzo esito negativo: la voce resta all'utente
    const third = await delivered(workId, "not_startable");
    await finishReleaseTest(third);
    const work = await workRow(workId);
    expect(work.status).toBe("awaiting_release");
    expect(work.testAutoRejects).toBe(2);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, work.pendingActionId!));
    expect(item!.status).toBe("pending");
    const after = await db.select().from(teamEventsTable).where(eq(teamEventsTable.instanceId, instanceId));
    expect(after.some((e) => e.bulletin === `Collaudo del lavoro 1: ${COLLAUDO_MESSAGES.autoFixExhausted}`)).toBe(true);
  });

  it("correzione automatica salta una voce già decisa", async () => {
    const { workId, itemId } = await seedWork("decisa", { autoFix: true });
    const id = await delivered(workId, "problems");
    await db.update(pendingActionsTable).set({ status: "executing" }).where(eq(pendingActionsTable.id, itemId));
    await finishReleaseTest(id);
    const work = await workRow(workId);
    expect(work.status).toBe("awaiting_release");
    expect(work.testAutoRejects).toBe(0);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, itemId));
    expect(item!.status).toBe("executing");
  });

  it("senza «Correggi da solo» o con esito ok la voce resta", async () => {
    const off = await seedWork("spento", { autoFix: false });
    await finishReleaseTest(await delivered(off.workId, "problems"));
    expect((await workRow(off.workId)).status).toBe("awaiting_release");
    const ok = await seedWork("verde", { autoFix: true });
    await finishReleaseTest(await delivered(ok.workId, "ok"));
    expect((await workRow(ok.workId)).status).toBe("awaiting_release");
  });
});

/** Attende che la condizione diventi vera (lavoro in background). */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condizione non raggiunta");
}

describe("claim, agente e report", () => {
  /** Collaudo lanciato e preso dal runner (`running`). */
  async function claimed(slug: string, opts: { autoFix?: boolean } = {}) {
    const seeded = await seedWork(slug, opts);
    const id = (await requestReleaseTest(seeded.workId))!;
    await scheduleReleaseTests();
    await db
      .update(releaseTestsTable)
      .set({ status: "running", tokenHash: "x", tokenExpiresAt: new Date(Date.now() + 60 * 60_000), leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(releaseTestsTable.id, id));
    return { ...seeded, testId: id };
  }

  it("mode full: parte l'agente e con esito problems e «Correggi da solo» la voce è rifiutata", async () => {
    const { testId, workId, itemId, instanceId } = await claimed("agente", { autoFix: true });
    onTestClaimed(testId, "full");
    await until(async () => (await workRow(workId)).status === "open");
    expect(agentMock.calls.map((c) => c.testId)).toEqual([testId]);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, itemId));
    expect(item!.status).toBe("rejected");
    expect(item!.decisionNote).toBe("Resoconto dell'agente");
    expect((await workRow(workId)).testAutoRejects).toBe(1);
    const [turn] = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
    expect(JSON.stringify(turn!.reasons)).toContain(COLLAUDO_MESSAGES.autoRejectTurn(1, "Resoconto dell'agente"));
    // Il collaudo resta `running` fino al report del runner
    expect((await testRow(testId)).status).toBe("running");
  });

  it("mode relight: nessun agente", async () => {
    const { testId } = await claimed("riaccendi");
    onTestClaimed(testId, "relight");
    await new Promise((r) => setTimeout(r, 50));
    expect(agentMock.calls).toEqual([]);
  });

  it("il report del runner ferma l'agente", async () => {
    agentMock.mode = "wait";
    const { testId } = await claimed("report");
    onTestClaimed(testId, "full");
    await until(async () => agentMock.calls.length === 1);
    const signal = agentMock.calls[0]!.signal!;
    expect(signal.aborted).toBe(false);
    await report(testId, "done");
    onTestReported(testId);
    expect(signal.aborted).toBe(true);
  });

  it("un collaudo più recente ferma l'agente del precedente (stato scritto prima)", async () => {
    agentMock.mode = "wait";
    const { testId, workId } = await claimed("sostituito");
    onTestClaimed(testId, "full");
    await until(async () => agentMock.calls.length === 1);
    const signal = agentMock.calls[0]!.signal!;
    let statusAtAbort: string | null = null;
    signal.addEventListener("abort", () => {
      void testRow(testId).then((r) => (statusAtAbort = r.status));
    });
    await db.update(teamWorksTable).set({ headSha: "fff9999" }).where(eq(teamWorksTable.id, workId));
    await requestReleaseTest(workId);
    expect(signal.aborted).toBe(true);
    await until(async () => statusAtAbort !== null);
    expect(statusAtAbort).toBe("cancelled");
  });
});
