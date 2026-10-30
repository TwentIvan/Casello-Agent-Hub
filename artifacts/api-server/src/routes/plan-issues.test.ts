import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, analysesTable, analysisItemsTable, appsTable, githubInstallationsTable } from "@workspace/db";
import { startFakeGithub, type FakeGithub, type FakeGithubRequest } from "../../test/fake-github";

// Creazione delle issue GitHub dalle voci approvate del piano (POST /apps/:id/plan/issues), con il
// finto GitHub. Senza login (AUTH_DISABLED=true: utente di sviluppo). Le richieste passano da un
// server con il router senza pausa e senza rate limit; il rate limit si prova sull'app vera.

const GITHUB_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_API_BASE",
  "GITHUB_WEB_BASE",
];
const ENV_KEYS = ["AUTH_DISABLED", "CASELLO_SECRET_KEY", ...GITHUB_KEYS];
const saved: Record<string, string | undefined> = {};

const REPO = "ivan/mister";
const PERMISSION =
  "L'App Casello non ha il permesso Issues su questo repository (o non lo vede più): attivalo nelle impostazioni dell'installazione su GitHub";
const DISABLED = "Le issue sono disattivate su questo repository";
const UNAVAILABLE = "GitHub non raggiungibile";
const NO_REPO = "Collega il repository tramite l'App GitHub per creare le issue";

let gh: FakeGithub;
let server: http.Server;
let small: http.Server;
let base: string;
let smallBase: string;
let userId: number;
let otherUserId: number;
let appId: number;
let analysisId: number;
let resetConfig: () => void;
let clearTokenCache: () => void;
let resetStaleIssueReservations: () => Promise<number>;

function listen(s: http.Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
}

function close(s: http.Server): Promise<void> {
  return new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  });
}

async function api(method: string, path: string, body?: unknown, root = smallBase) {
  const res = await fetch(`${root}/api${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as any) : undefined };
}

const issuesPost = (itemIds: number[], extra: Record<string, unknown> = {}, root = smallBase) =>
  api("POST", `/apps/${appId}/plan/issues`, { itemIds, ...extra }, root);

function configureGithub() {
  Object.assign(process.env, {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
  });
  resetConfig();
}

const completion = (key: string, dependsOn: string[] = []) => ({
  key,
  phase: 1,
  area: "api",
  title: `Titolo ${key}`,
  missing: "manca",
  evidence: [],
  goal: "obiettivo",
  dependsOn,
  files: [],
  effort: "S",
  doneWhen: "fatto",
  implementation: "come",
});

const evolution = (title: string) => ({
  area: "Rosa",
  title,
  type: "feature",
  impact: "high",
  effort: "M",
  priority: 2,
  motivation: "perché",
  implementation: "come",
});

let position = 0;
async function addItem(
  chapter: "completion" | "evolution",
  payload: Record<string, unknown>,
  over: { status?: "approved" | "pending" | "discarded"; analysisId?: number } = {},
): Promise<number> {
  position += 1;
  const [row] = await db
    .insert(analysisItemsTable)
    .values({
      analysisId: over.analysisId ?? analysisId,
      chapter,
      ref: `${chapter}:${position}`,
      position,
      diff: "new",
      payload,
      status: over.status ?? "approved",
    })
    .returning({ id: analysisItemsTable.id });
  return row!.id;
}

async function newAnalysis(forApp: number) {
  const [row] = await db
    .insert(analysesTable)
    .values({ appId: forApp, model: "m", sources: { code: "github", openapi: false, description: true }, maxTokens: 1000, status: "completed" })
    .returning();
  return row!.id;
}

const repoIssues = () => gh.issues.get(REPO) ?? [];
const issuePosts = () => gh.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"));
const itemRow = async (id: number) =>
  (await db.select().from(analysisItemsTable).where(eq(analysisItemsTable.id, id)))[0]!;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["AUTH_DISABLED"] = "true";
  process.env["CASELLO_SECRET_KEY"] = "d".repeat(64);
  gh = await startFakeGithub();

  const { default: app } = await import("../app");
  const { default: express } = await import("express");
  const { requireAuth } = await import("../lib/auth");
  const { errorHandler } = await import("../middlewares/error-handler");
  const { createPlanIssuesRouter } = await import("./plan-issues");
  ({ resetGithubConfigForTests: resetConfig } = await import("../lib/github/config"));
  ({ clearInstallationTokenCache: clearTokenCache } = await import("../lib/github/app"));
  ({ resetStaleIssueReservations } = await import("../lib/plan-issues/service"));
  const { ensureUserByEmail } = await import("../lib/users");
  userId = (await ensureUserByEmail("dev@localhost")).id;
  otherUserId = (await ensureUserByEmail("altro@example.com")).id;

  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
  const mini = express();
  mini.use(express.json());
  mini.use("/api", requireAuth, createPlanIssuesRouter({ pauseMs: 0, createRateLimit: (_req, _res, next) => next() }));
  mini.use("/api", errorHandler);
  small = http.createServer(mini);
  smallBase = `http://127.0.0.1:${await listen(small)}`;
});

afterAll(async () => {
  await close(server);
  await close(small);
  await gh.close();
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
});

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE github_installations RESTART IDENTITY");
  gh.installations.clear();
  gh.repos.clear();
  gh.installationPermissions.clear();
  gh.issues.clear();
  gh.labels.clear();
  gh.issuesDisabled.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  clearTokenCache();
  configureGithub();
  gh.addInstallation(
    { id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" },
    [{ fullName: REPO, defaultBranch: "main", private: true }],
  );
  await db.insert(githubInstallationsTable).values({
    userId,
    installationId: 11,
    accountLogin: "ivan",
    accountType: "User",
    repositorySelection: "selected",
  });
  const [app] = await db
    .insert(appsTable)
    .values({ name: "Mister", slug: "mister", baseUrl: "https://mister.example", sourceType: "github", sourceRepo: REPO, sourceInstallationId: 11 })
    .returning();
  appId = app!.id;
  analysisId = await newAnalysis(appId);
});

describe("POST /apps/:id/plan/issues", () => {
  it("anteprima: titoli, etichette, nessuna chiamata di creazione", async () => {
    const a = await addItem("completion", completion("a"));
    const e = await addItem("evolution", evolution("Statistiche"));
    const pending = await addItem("evolution", evolution("Da decidere"), { status: "pending" });
    const res = await issuesPost([e, a, pending], { dryRun: true });
    expect(res.status, res.text).toBe(200);
    expect(res.json.repo).toBe(REPO);
    expect(res.json.issues.map((i: any) => i.itemId)).toEqual([a, e, pending]);
    const [ia, ie, ip] = res.json.issues;
    expect(ia.title).toBe("Titolo a");
    expect(ia.labels).toEqual(["casello", "completamento", "fase-1"]);
    expect(ia.body).toContain(`Creata da Casello · piano di Mister · voce #${a}`);
    expect(ia.skipped).toBe(false);
    expect(ie.labels).toEqual(["casello", "evoluzione", "P2"]);
    expect(ip.skipped).toBe(true);
    expect(gh.requests).toHaveLength(0);
  });

  it("crea in ordine di dipendenza, #numero nel corpo, voci collegate", async () => {
    const b = await addItem("completion", completion("b", ["a"]));
    const a = await addItem("completion", completion("a"));
    const res = await issuesPost([b, a]);
    expect(res.status, res.text).toBe(200);
    expect(res.json.results).toEqual([
      { itemId: a, outcome: "created", number: 1, url: `https://github.com/${REPO}/issues/1` },
      { itemId: b, outcome: "created", number: 2, url: `https://github.com/${REPO}/issues/2` },
    ]);
    const issues = repoIssues();
    expect(issues.map((i) => i.title)).toEqual(["Titolo a", "Titolo b"]);
    expect(issues[1]!.body).toContain("#1");
    expect(issues[0]!.labels).toEqual(["casello", "completamento", "fase-1"]);
    expect([...(gh.labels.get(REPO) ?? [])].sort()).toEqual(["casello", "completamento", "fase-1"]);

    const plan = await api("GET", `/apps/${appId}/plan`, undefined, base);
    expect(plan.status, plan.text).toBe(200);
    const byId = new Map<number, any>(plan.json.items.map((i: any) => [i.id, i]));
    expect(byId.get(a).issue).toMatchObject({ repo: REPO, number: 1, url: `https://github.com/${REPO}/issues/1`, state: "open" });
    expect(byId.get(b).issue).toMatchObject({ number: 2, state: "open" });
    const row = await itemRow(a);
    expect(row.issueCreatedAt).not.toBeNull();
    expect(row.issueCheckedAt).not.toBeNull();
  });

  it("seconda richiesta sulle stesse voci → skipped, nessuna issue nuova", async () => {
    const a = await addItem("completion", completion("a"));
    expect((await issuesPost([a])).json.results[0].outcome).toBe("created");
    gh.requests.length = 0;
    const res = await issuesPost([a]);
    expect(res.status, res.text).toBe(200);
    expect(res.json.results).toEqual([{ itemId: a, outcome: "skipped" }]);
    expect(repoIssues()).toHaveLength(1);
    expect(gh.requests).toHaveLength(0);
  });

  it("creazioni concorrenti sulle stesse voci → una sola issue per voce", async () => {
    const ids = [
      await addItem("evolution", evolution("Uno")),
      await addItem("evolution", evolution("Due")),
      await addItem("evolution", evolution("Tre")),
    ];
    const [r1, r2] = await Promise.all([issuesPost(ids), issuesPost(ids)]);
    expect(r1.status, r1.text).toBe(200);
    expect(r2.status, r2.text).toBe(200);
    expect(repoIssues()).toHaveLength(3);
    for (const id of ids) {
      const outcomes = [r1, r2].map((r) => r.json.results.find((x: any) => x.itemId === id).outcome).sort();
      expect(outcomes).toEqual(["created", "skipped"]);
    }
  });

  it("dipendenza collegata in un lotto precedente → #numero", async () => {
    const a = await addItem("completion", completion("a"));
    const b = await addItem("completion", completion("b", ["a"]));
    const c = await addItem("completion", completion("c", ["x"]));
    await addItem("completion", completion("x"));
    expect((await issuesPost([a])).json.results[0]).toMatchObject({ outcome: "created", number: 1 });
    const res = await issuesPost([b, c]);
    expect(res.status, res.text).toBe(200);
    const [ib, ic] = repoIssues().slice(1);
    expect(ib!.body).toContain("#1");
    // Dipendenza senza issue: resta il titolo
    expect(ic!.body).toContain("Titolo x");
  });

  it("voce di un'altra app → 400; voce non approvata → skipped", async () => {
    const [other] = await db
      .insert(appsTable)
      .values({ name: "Altra", slug: "altra", baseUrl: "https://altra.example" })
      .returning();
    const foreign = await addItem("evolution", evolution("Altrove"), { analysisId: await newAnalysis(other!.id) });
    const mine = await addItem("evolution", evolution("Mia"));
    const res = await issuesPost([mine, foreign]);
    expect(res.status, res.text).toBe(400);
    expect((await issuesPost([mine, foreign], { dryRun: true })).status).toBe(400);
    expect((await issuesPost([mine, mine])).status).toBe(400);
    expect(repoIssues()).toHaveLength(0);

    const pending = await addItem("evolution", evolution("In attesa"), { status: "pending" });
    const ok = await issuesPost([pending, mine]);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.results).toEqual([
      { itemId: pending, outcome: "skipped" },
      { itemId: mine, outcome: "created", number: 1, url: `https://github.com/${REPO}/issues/1` },
    ]);
  });

  it("permesso Issues mancante → 502 con il messaggio, nessuna voce prenotata", async () => {
    gh.installationPermissions.set(11, { contents: "read", metadata: "read" });
    const a = await addItem("evolution", evolution("Uno"));
    const res = await issuesPost([a]);
    expect(res.status, res.text).toBe(502);
    expect(res.json.error).toBe(PERMISSION);
    const row = await itemRow(a);
    expect(row.issueState).toBeNull();
    expect(row.issueNumber).toBeNull();
    // L'anteprima non chiede il permesso
    expect((await issuesPost([a], { dryRun: true })).status).toBe(200);
  });

  it("500 su una voce → failed solo lei, le altre created, prenotazione tolta", async () => {
    const ids = [
      await addItem("evolution", evolution("Uno")),
      await addItem("evolution", evolution("Due")),
      await addItem("evolution", evolution("Tre")),
    ];
    gh.failWith = (req: FakeGithubRequest) =>
      req.method === "POST" && req.path.endsWith("/issues") && (req.body as { title?: string })?.title === "Due" ? 500 : null;
    const res = await issuesPost(ids);
    expect(res.status, res.text).toBe(200);
    expect(res.json.results.map((r: any) => r.outcome)).toEqual(["created", "failed", "created"]);
    expect(res.json.results[1].error).toBe(UNAVAILABLE);
    const row = await itemRow(ids[1]!);
    expect(row.issueState).toBeNull();
    expect(row.issueNumber).toBeNull();
    expect(repoIssues().map((i) => i.title)).toEqual(["Uno", "Tre"]);
  });

  it("issue disattivate a metà lotto → restanti failed", async () => {
    const ids = [
      await addItem("evolution", evolution("Uno")),
      await addItem("evolution", evolution("Due")),
      await addItem("evolution", evolution("Tre")),
    ];
    gh.failWith = (req: FakeGithubRequest) =>
      req.method === "POST" && req.path.endsWith("/issues") && (req.body as { title?: string })?.title === "Due" ? 410 : null;
    const res = await issuesPost(ids);
    expect(res.status, res.text).toBe(200);
    expect(res.json.results).toEqual([
      { itemId: ids[0], outcome: "created", number: 1, url: `https://github.com/${REPO}/issues/1` },
      { itemId: ids[1], outcome: "failed", error: DISABLED },
      { itemId: ids[2], outcome: "failed", error: DISABLED },
    ]);
    // La terza non è stata nemmeno tentata
    expect(issuePosts()).toHaveLength(2);
    for (const id of ids.slice(1)) expect((await itemRow(id)).issueState).toBeNull();
  });

  it("app senza installazione → 409 NO_REPO; installazione di un altro utente → 403", async () => {
    const a = await addItem("evolution", evolution("Uno"));
    await db.update(appsTable).set({ sourceInstallationId: null }).where(eq(appsTable.id, appId));
    const noRepo = await issuesPost([a]);
    expect(noRepo.status, noRepo.text).toBe(409);
    expect(noRepo.json.error).toBe(NO_REPO);
    expect((await issuesPost([a], { dryRun: true })).status).toBe(409);

    await db.update(githubInstallationsTable).set({ userId: otherUserId }).where(eq(githubInstallationsTable.installationId, 11));
    await db.update(appsTable).set({ sourceInstallationId: 11 }).where(eq(appsTable.id, appId));
    const notYours = await issuesPost([a]);
    expect(notYours.status, notYours.text).toBe(403);
    expect(notYours.json.error).toBe("installazione non trovata o non tua");
    expect((await api("POST", `/apps/99999/plan/issues`, { itemIds: [a] })).status).toBe(404);
    expect(gh.requests).toHaveLength(0);
  });

  it("resetStaleIssueReservations azzera le prenotazioni senza numero", async () => {
    const stale = await addItem("evolution", evolution("Rimasta"));
    const linked = await addItem("evolution", evolution("Collegata"));
    await db.update(analysisItemsTable).set({ issueState: "creating" }).where(eq(analysisItemsTable.id, stale));
    await db
      .update(analysisItemsTable)
      .set({ issueState: "open", issueNumber: 7, issueRepo: REPO, issueUrl: "https://github.com/ivan/mister/issues/7" })
      .where(eq(analysisItemsTable.id, linked));
    expect(await resetStaleIssueReservations()).toBe(1);
    expect((await itemRow(stale)).issueState).toBeNull();
    expect((await itemRow(linked)).issueState).toBe("open");
    // Tornata libera: si può creare
    expect((await issuesPost([stale])).json.results[0].outcome).toBe("created");
  });

  it("sesta creazione nel minuto → 429, anteprime non limitate", async () => {
    const a = await addItem("evolution", evolution("Uno"));
    for (let i = 0; i < 5; i++) {
      const r = await issuesPost([a], {}, base);
      expect(r.status, r.text).toBe(200);
    }
    expect((await issuesPost([a], {}, base)).status).toBe(429);
    const preview = await issuesPost([a], { dryRun: true }, base);
    expect(preview.status, preview.text).toBe(200);
    expect(repoIssues()).toHaveLength(1);
  });
});
