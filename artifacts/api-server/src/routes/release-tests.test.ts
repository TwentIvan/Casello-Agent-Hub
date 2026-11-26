import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appsTable,
  auditEventsTable,
  db,
  pendingActionsTable,
  pool,
  releaseTestFilesTable,
  releaseTestStepsTable,
  releaseTestsTable,
  teamInstancesTable,
  teamTurnsTable,
  teamWorksTable,
} from "@workspace/db";
import { ensureUser } from "../../test/team-node-fixture";

// Route del collaudo su un'app Express vera (porta 0), senza login (AUTH_DISABLED=true: utente di sviluppo). Senza
// COLLAUDO_REPO ogni richiesta di collaudo nasce `skipped`: niente lancio né runner.

const realFetch = globalThis.fetch;
const AGENT_EMAIL = "agente@example.com";
let base: string;
let server: http.Server;
const saved: Record<string, string | undefined> = {};
let createApiToken: typeof import("../lib/api-tokens").createApiToken;
let enqueueReleaseItem: typeof import("../lib/actions/queue").enqueueReleaseItem;
let resetTestRelightLimit: typeof import("../middlewares/rate-limit").resetTestRelightLimit;
let userId: number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await realFetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, headers: res.headers };
}

beforeAll(async () => {
  for (const k of ["AUTH_DISABLED", "ALLOWED_EMAILS", "COLLAUDO_REPO", "CASELLO_SECRET_KEY"]) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["ALLOWED_EMAILS"] = `${AGENT_EMAIL},dev@localhost`;
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  delete process.env["COLLAUDO_REPO"];
  const { requireAuth } = await import("../lib/auth");
  const { createReleaseTestsRouter, createCollaudoSetupRouter } = await import("./release-tests");
  const { createPendingActionsRouter } = await import("./pending-actions");
  const { auditRoutes } = await import("../lib/audit/record");
  const { errorHandler } = await import("../middlewares/error-handler");
  ({ createApiToken } = await import("../lib/api-tokens"));
  ({ enqueueReleaseItem } = await import("../lib/actions/queue"));
  ({ resetTestRelightLimit } = await import("../middlewares/rate-limit"));
  const mini = express();
  mini.use(express.json());
  mini.use("/api/collaudo/setup", requireAuth, createCollaudoSetupRouter());
  mini.use("/api", requireAuth, auditRoutes(), createReleaseTestsRouter(), createPendingActionsRouter());
  mini.use("/api", errorHandler);
  server = http.createServer(mini);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("TRUNCATE apps, users, team_instances RESTART IDENTITY CASCADE");
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  await pool.query("TRUNCATE apps, users, team_instances RESTART IDENTITY CASCADE");
  resetTestRelightLimit();
  userId = await ensureUser("dev@localhost");
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** App con squadra, lavoro in attesa di «Porta in produzione» con la sua voce e un collaudo concluso con problemi. */
async function seed(opts: { owner?: number } = {}) {
  const [app] = await db.insert(appsTable).values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example.com" }).returning();
  const [instance] = await db
    .insert(teamInstancesTable)
    .values({ name: "Squadra", refAppId: app!.id, refType: "piano", refId: "1", refTitle: "Piano", roles: [], status: "active", createdBy: userId, activatedBy: userId })
    .returning();
  const queued = await enqueueReleaseItem({ userId: opts.owner ?? userId, instanceId: instance!.id, recipient: "ivan/mister", summary: "Porta in produzione il lavoro 1", detail: {} });
  if (!queued.ok) throw new Error("voce non accodata");
  const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, queued.number));
  const [work] = await db
    .insert(teamWorksTable)
    .values({
      instanceId: instance!.id,
      number: 1,
      repo: "ivan/mister",
      branch: `botcave/lavoro-${instance!.id}-1`,
      baseBranch: "main",
      baseSha: "abc1234",
      headSha: "def5678",
      status: "awaiting_release",
      pendingActionId: item!.id,
    })
    .returning();
  const [test] = await db
    .insert(releaseTestsTable)
    .values({
      appId: app!.id,
      workId: work!.id,
      instanceId: instance!.id,
      sha: "def5678",
      mode: "full",
      status: "done",
      outcome: "problems",
      report: "# Esito\nIl pulsante Salva non risponde.\n",
      problems: [{ task: "t1", title: "Salva non risponde", steps: "Apri e premi", expected: "Salva", actual: "Niente", screenshot: 1 }],
      notTestable: ["Invio email"],
      tokenHash: "segreto-hash",
      codeHash: "altro-hash",
      tunnelUrl: "https://abc.trycloudflare.com",
      tunnelUntil: new Date(Date.now() - 60_000),
      costUsd: "0.250000",
    })
    .returning();
  return { appId: app!.id, instanceId: instance!.id, workId: work!.id, itemId: item!.id, itemNumber: queued.number, testId: test!.id };
}

describe("elenco e dettaglio dei collaudi", () => {
  it("elenco per lavoro o per App, senza filtro 400", async () => {
    const { workId, appId, testId } = await seed();
    const byWork = await api("GET", `/release-tests?workId=${workId}`);
    expect(byWork.status, byWork.text).toBe(200);
    expect(byWork.json).toHaveLength(1);
    expect(byWork.json[0]).toMatchObject({ id: testId, status: "done", outcome: "problems", costUsd: 0.25 });
    // Mai gli hash di codice e token
    expect(byWork.text).not.toContain("segreto-hash");
    expect(byWork.text).not.toContain("altro-hash");
    expect((await api("GET", `/release-tests?appId=${appId}`)).json).toHaveLength(1);
    expect((await api("GET", `/release-tests?appId=${appId + 1}`)).json).toEqual([]);
    const none = await api("GET", "/release-tests");
    expect(none.status).toBe(400);
    expect(none.json.error).toBe("indica workId o appId");
  });

  it("il dettaglio e l'elenco riportano autoRejects del lavoro", async () => {
    const { testId, workId } = await seed();
    await db.update(teamWorksTable).set({ testAutoRejects: 2 }).where(eq(teamWorksTable.id, workId));
    expect((await api("GET", `/release-tests/${testId}`)).json.autoRejects).toBe(2);
    expect((await api("GET", `/release-tests?workId=${workId}`)).json[0].autoRejects).toBe(2);
  });

  it("dettaglio con passi e file; il link dal vivo scaduto non esce", async () => {
    const { testId } = await seed();
    await db.insert(releaseTestStepsTable).values({ testId, position: 1, type: "tool", toolName: "shell", ok: true, durationMs: 1200 });
    await db.insert(releaseTestFilesTable).values({ testId, kind: "screenshot", name: "salva.png", contentType: "image/png", size: PNG.length, sha256: "0".repeat(64), content: PNG });
    const res = await api("GET", `/release-tests/${testId}`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({
      id: testId,
      report: expect.stringContaining("Salva non risponde"),
      problems: [{ title: "Salva non risponde", screenshot: 1 }],
      notTestable: ["Invio email"],
      tunnelUrl: null,
      tunnelUntil: null,
    });
    expect(res.json).not.toHaveProperty("activity");
    expect(res.json.steps).toHaveLength(1);
    expect(res.json.steps[0]).toMatchObject({ position: 1, type: "tool", toolName: "shell", ok: true });
    expect(res.json.steps[0]).not.toHaveProperty("testId");
    expect(res.json.files).toEqual([{ id: expect.any(Number), kind: "screenshot", name: "salva.png", contentType: "image/png", size: PNG.length }]);
    expect((await api("GET", "/release-tests/999")).status).toBe(404);
  });

  it("link dal vivo ancora valido: esce", async () => {
    const { testId } = await seed();
    await db.update(releaseTestsTable).set({ tunnelUntil: new Date(Date.now() + 600_000) }).where(eq(releaseTestsTable.id, testId));
    const res = await api("GET", `/release-tests/${testId}`);
    expect(res.json.tunnelUrl).toBe("https://abc.trycloudflare.com");
  });

  it("scarico di un file: intestazioni sicure; file di un altro collaudo o inesistente → 404", async () => {
    const { testId, appId, workId, instanceId } = await seed();
    const [file] = await db
      .insert(releaseTestFilesTable)
      .values({ testId, kind: "screenshot", name: "salva.png", contentType: "image/png", size: PNG.length, sha256: "0".repeat(64), content: PNG })
      .returning();
    const res = await realFetch(`${base}/api/release-tests/${testId}/files/${file!.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Si apre nel browser (miniatura e video), sempre con nosniff
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    const [other] = await db
      .insert(releaseTestsTable)
      .values({ appId, workId, instanceId, sha: "aaaa", status: "cancelled" })
      .returning();
    expect((await api("GET", `/release-tests/${other!.id}/files/${file!.id}`)).status).toBe(404);
    expect((await api("GET", `/release-tests/${testId}/files/999`)).status).toBe(404);
  });
});

describe("Riaccendi", () => {
  it("collaudo non concluso → 409", async () => {
    const { testId } = await seed();
    await db.update(releaseTestsTable).set({ status: "running" }).where(eq(releaseTestsTable.id, testId));
    const res = await api("POST", `/release-tests/${testId}/relight`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("il collaudo non è concluso: aspetta la fine");
  });

  it("collaudo concluso con la voce in attesa → 202 con un collaudo nuovo in modalità relight", async () => {
    const { testId, workId } = await seed();
    const res = await api("POST", `/release-tests/${testId}/relight`);
    expect(res.status, res.text).toBe(202);
    expect(res.json).toMatchObject({ workId, mode: "relight" });
    expect(res.json.id).not.toBe(testId);
    expect(await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.workId, workId))).toHaveLength(2);
  });

  it("solo l'ultimo collaudo full del lavoro: uno più vecchio, con un collaudo nuovo in corso, non si riaccende e il nuovo resta", async () => {
    const { testId, workId, appId, instanceId } = await seed();
    const [fresh] = await db
      .insert(releaseTestsTable)
      .values({ appId, workId, instanceId, sha: "def5678", mode: "full", status: "running" })
      .returning();
    const res = await api("POST", `/release-tests/${testId}/relight`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("«Riaccendi» vale solo per l'ultimo collaudo completo del lavoro");
    expect((await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, fresh!.id)))[0]!.status).toBe("running");
  });

  it("un collaudo full in corso di un'altra squadra della stessa App non si annulla: il relight aspetta in coda", async () => {
    const { testId, appId } = await seed();
    const [other] = await db
      .insert(teamInstancesTable)
      .values({ name: "Altra", refAppId: appId, refType: "piano", refId: "2", refTitle: "Piano", roles: [], status: "active", createdBy: userId, activatedBy: userId })
      .returning();
    const [otherWork] = await db
      .insert(teamWorksTable)
      .values({ instanceId: other!.id, number: 1, repo: "ivan/mister", branch: `botcave/lavoro-${other!.id}-1`, baseBranch: "main", baseSha: "abc1234", headSha: "aaa1111", status: "open" })
      .returning();
    const [running] = await db
      .insert(releaseTestsTable)
      .values({ appId, workId: otherWork!.id, instanceId: other!.id, sha: "aaa1111", mode: "full", status: "running" })
      .returning();
    // Con il repository di collaudo configurato (altrimenti ogni richiesta nasce subito `skipped`); il rifiuto non lancia nulla
    process.env["COLLAUDO_REPO"] = "ivan/collaudo";
    let res: Awaited<ReturnType<typeof api>>;
    try {
      res = await api("POST", `/release-tests/${testId}/relight`);
    } finally {
      delete process.env["COLLAUDO_REPO"];
    }
    expect(res.status, res.text).toBe(202);
    expect(res.json).toMatchObject({ mode: "relight", status: "queued" });
    expect((await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.id, running!.id)))[0]!.status).toBe("running");
  });

  it("voce già decisa → 409; voce di un altro utente → 404; collaudo inesistente → 404", async () => {
    const { testId, itemId } = await seed();
    await db.update(pendingActionsTable).set({ status: "rejected" }).where(eq(pendingActionsTable.id, itemId));
    expect((await api("POST", `/release-tests/${testId}/relight`)).status).toBe(409);
    await db.update(pendingActionsTable).set({ status: "pending", userId: await ensureUser("altro@example.com") }).where(eq(pendingActionsTable.id, itemId));
    expect((await api("POST", `/release-tests/${testId}/relight`)).status).toBe(404);
    expect((await api("POST", "/release-tests/999/relight")).status).toBe(404);
  });

  it("al più 6 al giorno per voce, poi 429", async () => {
    const { testId } = await seed();
    for (let i = 0; i < 6; i++) expect((await api("POST", `/release-tests/${testId}/relight`)).status).toBe(202);
    const res = await api("POST", `/release-tests/${testId}/relight`);
    expect(res.status).toBe(429);
    expect(res.json.error).toBe("limite di «Riaccendi» di oggi raggiunto: riprova domani");
  });

  it("il token agent non può (403) e nulla cambia", async () => {
    const { testId, workId } = await seed();
    const agent = await ensureUser(AGENT_EMAIL);
    const { token } = await createApiToken(agent, "Agente", 30, ["agent"]);
    const res = await api("POST", `/release-tests/${testId}/relight`, undefined, token);
    expect(res.status).toBe(403);
    expect(await db.select().from(releaseTestsTable).where(eq(releaseTestsTable.workId, workId))).toHaveLength(1);
    expect((await api("POST", `/release-tests/${testId}/send-back`, undefined, token)).status).toBe(403);
  });
});

describe("Rimanda alla squadra", () => {
  it("rifiuta la voce con il resoconto, riapre il lavoro e sveglia il capo; poi 409", async () => {
    const { testId, itemId, workId, instanceId } = await seed();
    const res = await api("POST", `/release-tests/${testId}/send-back`);
    expect(res.status, res.text).toBe(204);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, itemId));
    expect(item).toMatchObject({ status: "rejected" });
    expect(item!.decisionNote).toContain("Salva non risponde");
    const [work] = await db.select().from(teamWorksTable).where(eq(teamWorksTable.id, workId));
    expect(work).toMatchObject({ status: "open", pendingActionId: null, testAutoRejects: 0 });
    const turns = await db.select().from(teamTurnsTable).where(eq(teamTurnsTable.instanceId, instanceId));
    expect(JSON.stringify(turns.map((t) => t.reasons))).toContain("L'utente ha rimandato il lavoro 1 alla squadra");
    const again = await api("POST", `/release-tests/${testId}/send-back`);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("la voce «Porta in produzione» è già stata decisa");
  });

  it("solo l'ultimo collaudo completo, concluso: un relight o un collaudo in corso → 409", async () => {
    const { testId, workId, appId, instanceId } = await seed();
    const [relight] = await db.insert(releaseTestsTable).values({ appId, workId, instanceId, sha: "def5678", mode: "relight", status: "done" }).returning();
    const onRelight = await api("POST", `/release-tests/${relight!.id}/send-back`);
    expect(onRelight.status).toBe(409);
    expect(onRelight.json.error).toBe("«Rimanda alla squadra» vale solo per l'ultimo collaudo completo del lavoro");
    await db.update(releaseTestsTable).set({ status: "running" }).where(eq(releaseTestsTable.id, testId));
    const running = await api("POST", `/release-tests/${testId}/send-back`);
    expect(running.status).toBe(409);
    expect(running.json.error).toBe("il collaudo non è concluso: aspetta la fine");
    // Un collaudo completo non riuscito si rimanda con il suo motivo
    await db.update(releaseTestsTable).set({ status: "failed", report: null, error: "collaudo interrotto" }).where(eq(releaseTestsTable.id, testId));
    expect((await api("POST", `/release-tests/${testId}/send-back`)).status).toBe(204);
  });

  it("voce di un altro utente → 404, collaudo inesistente → 404", async () => {
    const { testId } = await seed({ owner: await ensureUser("altro@example.com") });
    expect((await api("POST", `/release-tests/${testId}/send-back`)).status).toBe(404);
    expect((await api("POST", "/release-tests/999/send-back")).status).toBe(404);
  });

  it("la nota è al più 4 000 caratteri", async () => {
    const { testId, itemId } = await seed();
    await db.update(releaseTestsTable).set({ report: "x".repeat(6_000) }).where(eq(releaseTestsTable.id, testId));
    expect((await api("POST", `/release-tests/${testId}/send-back`)).status).toBe(204);
    const [item] = await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.id, itemId));
    expect(item!.decisionNote).toHaveLength(4_000);
  });
});

describe("ricetta di avvio", () => {
  const recipe = {
    install: ["npm ci"],
    build: [],
    services: [{ name: "web", command: "npm start", port: 3000, readyPath: "/" }],
    postgres: false,
    schema: [],
    env: {},
    startUrl: "/",
    login: null,
  };

  it("senza ricetta: versione 0; PUT valida salva la versione con origine user", async () => {
    const { appId } = await seed();
    const empty = await api("GET", `/apps/${appId}/test-recipe`);
    expect(empty.json).toEqual({ version: 0, source: null, recipe: null, versions: [] });
    const saved = await api("PUT", `/apps/${appId}/test-recipe`, { recipe });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toMatchObject({ version: 1, source: "user", recipe });
    await api("PUT", `/apps/${appId}/test-recipe`, { recipe: { ...recipe, install: ["npm install"] } });
    const read = await api("GET", `/apps/${appId}/test-recipe`);
    expect(read.json.version).toBe(2);
    expect(read.json.versions.map((v: { version: number; source: string }) => [v.version, v.source])).toEqual([[2, "user"], [1, "user"]]);
    const [app] = await db.select().from(appsTable).where(eq(appsTable.id, appId));
    expect(app).toMatchObject({ testRecipeVersion: 2 });
  });

  it("ricetta non valida → 400 col messaggio e nulla salvato; App inesistente → 404", async () => {
    const { appId } = await seed();
    const bad = await api("PUT", `/apps/${appId}/test-recipe`, { recipe: { ...recipe, install: ["npm ci\nrm -rf /"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^ricetta non valida: /);
    expect((await api("GET", `/apps/${appId}/test-recipe`)).json.version).toBe(0);
    expect((await api("PUT", "/apps/999/test-recipe", { recipe })).status).toBe(404);
    expect((await api("GET", "/apps/999/test-recipe")).status).toBe(404);
  });

  it("il token agent legge ma non scrive", async () => {
    const { appId } = await seed();
    const agent = await ensureUser(AGENT_EMAIL);
    const { token } = await createApiToken(agent, "Agente", 30, ["agent"]);
    expect((await api("GET", `/apps/${appId}/test-recipe`, undefined, token)).status).toBe(200);
    expect((await api("PUT", `/apps/${appId}/test-recipe`, { recipe }, token)).status).toBe(403);
  });
});

describe("«Da confermare» e configurazione", () => {
  it("la voce release porta l'esito del collaudo, le altre null", async () => {
    const { itemNumber, testId } = await seed();
    const res = await api("GET", "/pending-actions");
    expect(res.status, res.text).toBe(200);
    const item = res.json.actions.find((a: { number: number }) => a.number === itemNumber);
    expect(item.releaseTest).toEqual({ id: testId, status: "done", outcome: "problems", relight: null });
    const detail = await api("GET", `/pending-actions/${itemNumber}`);
    expect(detail.json.releaseTest).toEqual({ id: testId, status: "done", outcome: "problems", relight: null });
  });

  it("dopo «Riaccendi» la voce porta ancora il collaudo completo, con il relight e il suo link dal vivo a parte", async () => {
    const { itemNumber, testId, workId, appId, instanceId } = await seed();
    const until = new Date(Date.now() + 10 * 60_000);
    const [relight] = await db
      .insert(releaseTestsTable)
      .values({ appId, workId, instanceId, sha: "def5678", mode: "relight", status: "running", tunnelUrl: "https://vivo.trycloudflare.com", tunnelUntil: until })
      .returning();
    const detail = await api("GET", `/pending-actions/${itemNumber}`);
    expect(detail.json.releaseTest).toEqual({
      id: testId,
      status: "done",
      outcome: "problems",
      relight: { id: relight!.id, status: "running", error: null, tunnelUrl: "https://vivo.trycloudflare.com", tunnelUntil: until.toISOString() },
    });
    // «Riaccendi» si chiede ancora sul collaudo completo; il centralino riassume sempre il completo
    await db.update(releaseTestsTable).set({ status: "failed", error: "ricetta di avvio non riuscita", tunnelUrl: null, tunnelUntil: null }).where(eq(releaseTestsTable.id, relight!.id));
    expect((await api("POST", `/release-tests/${testId}/relight`)).status).toBe(202);
    const { pendingQueue } = await import("../lib/teams/centralino");
    expect((await pendingQueue(userId)).actions[0]).toMatchObject({ releaseTest: { outcome: "problems", summary: "Esito" } });
  });

  it("coda del centralino con l'esito e la sintesi del resoconto", async () => {
    await seed();
    const { pendingQueue } = await import("../lib/teams/centralino");
    const queue = await pendingQueue(userId);
    expect(queue.actions[0]).toMatchObject({ kind: "release", releaseTest: { status: "done", outcome: "problems", summary: "Esito" } });
  });

  it("configurazione: solo con il login", async () => {
    const ok = await api("GET", "/collaudo/setup");
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json).toEqual({ repo: null, installed: false, workflow: false, actionsWrite: false });
    expect((await api("POST", "/collaudo/setup/verify")).json).toMatchObject({ repo: null });
    const agent = await ensureUser(AGENT_EMAIL);
    const { token } = await createApiToken(agent, "Script", 30, ["api:write"]);
    expect((await api("GET", "/collaudo/setup", undefined, token)).status).toBe(403);
    expect((await api("POST", "/collaudo/setup/verify", undefined, token)).status).toBe(403);
  });
});

describe("registro delle azioni", () => {
  it("Riaccendi, Rimanda alla squadra e ricetta lasciano un evento senza contenuti", async () => {
    const { testId, appId } = await seed();
    const recipe = { install: [], build: [], services: [], postgres: false, schema: [], env: {}, startUrl: "/", login: null };
    expect((await api("PUT", `/apps/${appId}/test-recipe`, { recipe })).status).toBe(200);
    expect((await api("POST", `/release-tests/${testId}/relight`)).status).toBe(202);
    expect((await api("POST", `/release-tests/${testId}/send-back`)).status).toBe(204);
    for (let i = 0; i < 50 && (await db.select().from(auditEventsTable)).length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    const events = await db.select().from(auditEventsTable);
    expect(events.map((e) => e.action).sort()).toEqual(["app.test_recipe.update", "release_test.relight", "release_test.send_back"]);
    expect(JSON.stringify(events)).not.toContain("Salva non risponde");
  });
});
