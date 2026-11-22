import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  analysesTable,
  appBootstrapsTable,
  appsTable,
  db,
  githubInstallationsTable,
  pendingActionsTable,
  pool,
  usersTable,
} from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import { resetGithubConfigForTests } from "../github/config";
import { encryptSecret } from "../secrets";
import { logger } from "../logger";

// Nascita di un'App da zero: richiesta, decisione, passi in background, ripresa e riavvio (PGlite + finto GitHub)

vi.mock("../architect/run-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../architect/run-analysis")>();
  return { ...orig, startAnalysis: vi.fn(async () => {}) };
});

import { approveAction, failInterruptedActions, rejectAction } from "../actions/decide";
import { APP_BOOTSTRAP_MESSAGES as M } from "./messages";
import { createBootstrap, failInterruptedBootstraps, retryBootstrap, settleBootstrapRuns } from "./service";

const REPO = "ivan/portfolio";
const INST = 7;
const MARKER = JSON.stringify({ template: "botcave-modello-app", version: 1 });
const ENV_KEYS = ["CASELLO_SECRET_KEY", "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_API_BASE", "GITHUB_WEB_BASE", "APP_TEMPLATE_REPO"];
const saved: Record<string, string | undefined> = {};
let gh: FakeGithub;
let userId: number;
let modelId: number;

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  gh = await startFakeGithub();
  Object.assign(process.env, {
    GITHUB_APP_ID: gh.appId,
    GITHUB_APP_SLUG: gh.slug,
    GITHUB_APP_CLIENT_ID: gh.clientId,
    GITHUB_APP_CLIENT_SECRET: gh.clientSecret,
    GITHUB_APP_PRIVATE_KEY: gh.privateKeyPem,
    GITHUB_API_BASE: gh.apiBase,
    GITHUB_WEB_BASE: gh.webBase,
    CASELLO_SECRET_KEY: "a".repeat(64),
    APP_TEMPLATE_REPO: "TwentIvan/botcave-modello-app",
  });
  resetGithubConfigForTests();
});

afterAll(async () => {
  await gh.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetGithubConfigForTests();
  await pool.query("TRUNCATE users, apps, ai_accounts, app_bootstraps, pending_actions RESTART IDENTITY CASCADE");
});

beforeEach(async () => {
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.repos.clear();
  gh.templates.clear();
  gh.git.clear();
  gh.failWith = null;
  gh.addInstallation({ id: INST, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "selected" }, [
    { fullName: REPO, defaultBranch: "main", private: true },
  ]);
  gh.installationPermissions.set(INST, { contents: "write", metadata: "read" });
  gh.templates.set(REPO, "TwentIvan/botcave-modello-app");
  gh.seedRepo(REPO, "main", {
    ".botcave/modello.json": MARKER,
    "README.md": "# __APP_NAME__ su __DOMAIN__",
    "artifacts/__SLUG__-web/index.ts": "export const slug = '__SLUG__';",
    "AGENT_BRIEF.md": "brief di esempio",
  });

  await pool.query("TRUNCATE users, apps, ai_accounts, app_bootstraps, pending_actions RESTART IDENTITY CASCADE");
  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = u!.id;
  await db.insert(githubInstallationsTable).values({ userId, installationId: INST, accountLogin: "ivan", accountType: "User", repositorySelection: "selected", userRepos: [REPO] });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: "https://api.example.com/v1", apiKeyEnc: encryptSecret("sk-x"), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
});

const body = (over: Partial<Parameters<typeof createBootstrap>[1]> = {}) => ({
  name: "Portfolio",
  slug: "portfolio",
  domain: "portfolio.fantamister.cloud",
  brief: "# Portfolio\n\nUn sito per i miei lavori.",
  repo: "Ivan/Portfolio",
  installationId: INST,
  aiModelId: modelId,
  ...over,
});

async function created(): Promise<{ id: number; number: number }> {
  const r = await createBootstrap(userId, body());
  if (!r.ok) throw new Error(r.message);
  return { id: r.id, number: r.pendingActionNumber };
}

const bootstrapRow = async (id: number) => (await db.select().from(appBootstrapsTable).where(eq(appBootstrapsTable.id, id)))[0]!;
const actionRow = async (number: number) => (await db.select().from(pendingActionsTable).where(eq(pendingActionsTable.number, number)))[0]!;
const commitCount = () => gh.git.get(REPO)!.commits.size;

describe("richiesta done e App eliminata", () => {
  it("con l'App la richiesta done blocca slug e repository; eliminata l'App (app_id null) si riparte", async () => {
    const { id } = await created();
    const [other] = await db.insert(appsTable).values({ name: "Altra", slug: "altra", baseUrl: "https://altra.example.com" }).returning();
    await db.update(appBootstrapsTable).set({ status: "done", appId: other!.id }).where(eq(appBootstrapsTable.id, id));
    await db.update(pendingActionsTable).set({ status: "done" });
    expect(await createBootstrap(userId, body())).toEqual({ ok: false, status: 409, message: M.requestOpen });
    // `ON DELETE SET NULL`: eliminare l'App lascia la riga done senza App
    await db.delete(appsTable).where(eq(appsTable.id, other!.id));
    expect((await bootstrapRow(id)).appId).toBeNull();
    const again = await createBootstrap(userId, body());
    expect(again.ok).toBe(true);
  });
});

describe("createBootstrap e passi", () => {
  it("voce app_bootstrap con i nomi, poi i quattro passi fino all'App con analisi", async () => {
    const { id, number } = await created();
    const item = await actionRow(number);
    expect(item.kind).toBe("app_bootstrap");
    expect(item.status).toBe("pending");
    expect(item.summary).toBe("Crea l'app Portfolio da zero");
    expect(item.recipient).toBe(REPO);
    const pub = item.argsPublic as Record<string, unknown>;
    expect((pub["names"] as Record<string, string>)["apiService"]).toBe("portfolio-api");
    expect(pub["steps"]).toHaveLength(4);
    expect(typeof pub["analysisEstimateUsd"]).toBe("number");
    expect(pub["monthly"]).toBe("in tappa 1 nulla: Neon e Coolify li crei tu (lista guidata)");
    const before = await bootstrapRow(id);
    expect(before.repo).toBe(REPO);
    expect(before.steps.map((s) => s.status)).toEqual(["pending", "pending", "pending", "pending"]);

    const approved = await approveAction(userId, number);
    expect(approved.ok && approved.action.status).toBe("executing");
    await settleBootstrapRuns();

    const row = await bootstrapRow(id);
    expect(row.status).toBe("done");
    expect(row.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
    const [app] = await db.select().from(appsTable).where(eq(appsTable.slug, "portfolio"));
    expect(app!.sourceBranch).toBe("main");
    expect(app!.baseUrl).toBe("https://portfolio.fantamister.cloud");
    expect(app!.functionalDescription).toBe(body().brief);
    expect(row.appId).toBe(app!.id);
    const agents = await db.select().from(agentsTable).where(eq(agentsTable.appId, app!.id));
    expect(agents.map((a) => a.role)).toEqual(["general"]);
    expect(agents[0]!.aiModelId).toBe(modelId);
    const [analysis] = await db.select().from(analysesTable).where(eq(analysesTable.appId, app!.id));
    expect(["queued", "running"]).toContain(analysis!.status);
    expect(row.analysisId).toBe(analysis!.id);
    const done = await actionRow(number);
    expect(done.status).toBe("done");
    expect(done.result).toBe("App Portfolio pronta: completa la lista guidata");

    const files = gh.filesAt(REPO, "main");
    expect(files["AGENT_BRIEF.md"]).toBe(body().brief);
    expect(files["artifacts/portfolio-web/index.ts"]).toBe("export const slug = 'portfolio';");
    expect(files["artifacts/__SLUG__-web/index.ts"]).toBeUndefined();
    const head = gh.git.get(REPO)!.refs.get("heads/main")!;
    expect(row.initCommitSha).toBe(head);
    expect(gh.git.get(REPO)!.commits.get(head)!.message).toBe(`Inizializza Portfolio\n\nBotcave · nuova app da zero · richiesta ${id}`);
  });

  it("un'App con lo stesso slug nata dopo la richiesta fa fallire register con slugTaken", async () => {
    const { id, number } = await created();
    await db.insert(appsTable).values({ name: "Altra", slug: "portfolio", baseUrl: "https://altra.example" });
    await approveAction(userId, number);
    await settleBootstrapRuns();
    const row = await bootstrapRow(id);
    expect(row.status).toBe("failed");
    const register = row.steps.find((s) => s.key === "register")!;
    expect(register.status).toBe("failed");
    expect(register.message).toBe(M.slugTaken("portfolio"));
    expect((await db.select().from(appsTable).where(eq(appsTable.slug, "portfolio"))).length).toBe(1);
    const item = await actionRow(number);
    expect(item.status).toBe("failed");
    expect(item.errorMessage).toBe(`passo register: ${M.slugTaken("portfolio")}`);
  });

  it("Riprova dopo un errore al passo register: un solo commit di inizializzazione e una sola App", async () => {
    const { id, number } = await created();
    const [blocker] = await db.insert(appsTable).values({ name: "Altra", slug: "portfolio", baseUrl: "https://altra.example" }).returning();
    await approveAction(userId, number);
    await settleBootstrapRuns();
    expect((await bootstrapRow(id)).status).toBe("failed");
    expect(commitCount()).toBe(2);

    await db.delete(appsTable).where(eq(appsTable.id, blocker!.id));
    expect(await retryBootstrap(userId + 1, id)).toEqual({ ok: false, status: 404, message: M.notFound });
    const retried = await retryBootstrap(userId, id);
    expect(retried.ok).toBe(true);
    expect((await actionRow(number)).status).toBe("executing");
    await settleBootstrapRuns();

    const row = await bootstrapRow(id);
    expect(row.status).toBe("done");
    expect(row.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
    expect(commitCount()).toBe(2);
    expect((await db.select().from(appsTable).where(eq(appsTable.slug, "portfolio"))).length).toBe(1);
    expect((await actionRow(number)).status).toBe("done");
    expect(await retryBootstrap(userId, id)).toEqual({ ok: false, status: 409, message: M.notRetryable });
  });

  it("Riprova dopo un errore del commit: il passo personalize riparte e scrive una volta", async () => {
    const { id, number } = await created();
    gh.failWith = (req) => (req.method === "POST" && req.path.endsWith("/git/commits") ? 500 : null);
    await approveAction(userId, number);
    await settleBootstrapRuns();
    gh.failWith = null;
    const failed = await bootstrapRow(id);
    expect(failed.status).toBe("failed");
    expect(failed.steps.find((s) => s.key === "personalize")!.status).toBe("failed");
    expect(failed.steps.find((s) => s.key === "verify")!.status).toBe("done");
    await retryBootstrap(userId, id);
    await settleBootstrapRuns();
    expect((await bootstrapRow(id)).status).toBe("done");
    expect(commitCount()).toBe(2);
  });
});

describe("controlli della richiesta", () => {
  it("brief con una credenziale: 400 briefCredential", async () => {
    expect(await createBootstrap(userId, body({ brief: "chiave sk-" + "a".repeat(20) }))).toEqual({ ok: false, status: 400, message: M.briefCredential });
  });

  it("repository diverso dallo slug: 400 repoMismatch; repository non visibile: 403", async () => {
    expect(await createBootstrap(userId, body({ repo: "ivan/altro" }))).toEqual({ ok: false, status: 400, message: M.repoMismatch });
    expect((await createBootstrap(userId, body({ slug: "sito", repo: "ivan/sito", domain: "sito.fantamister.cloud" }))).ok).toBe(false);
    const r = await createBootstrap(userId, body({ slug: "sito", repo: "ivan/sito", domain: "sito.fantamister.cloud" }));
    expect(r.ok === false && r.status).toBe(403);
  });

  it("slug o dominio già usati da un'App: 409", async () => {
    await db.insert(appsTable).values({ name: "Altra", slug: "portfolio", baseUrl: "https://altra.example" });
    expect(await createBootstrap(userId, body())).toEqual({ ok: false, status: 409, message: M.slugTaken("portfolio") });
    await db.update(appsTable).set({ slug: "altra", baseUrl: "https://portfolio.fantamister.cloud/" });
    expect(await createBootstrap(userId, body())).toEqual({ ok: false, status: 409, message: M.domainTaken });
  });

  it("seconda richiesta per lo stesso repository: 409 requestOpen", async () => {
    await created();
    expect(await createBootstrap(userId, body({ domain: "altro.fantamister.cloud" }))).toEqual({ ok: false, status: 409, message: M.requestOpen });
  });
});

describe("rifiuto e riavvio", () => {
  it("rifiutare la voce chiude la richiesta e libera lo slug", async () => {
    const { id, number } = await created();
    const res = await rejectAction(userId, number, null);
    expect(res.ok).toBe(true);
    expect((await bootstrapRow(id)).status).toBe("rejected");
    expect((await createBootstrap(userId, body())).ok).toBe(true);
  });

  it("failInterruptedBootstraps: richiesta e voce running → failed «interrotto dal riavvio»", async () => {
    const { id, number } = await created();
    const item = await actionRow(number);
    await db.update(pendingActionsTable).set({ status: "executing" }).where(eq(pendingActionsTable.id, item.id));
    const row = await bootstrapRow(id);
    await db
      .update(appBootstrapsTable)
      .set({ status: "running", steps: row.steps.map((s) => (s.key === "verify" ? { ...s, status: "done" as const } : s)) })
      .where(eq(appBootstrapsTable.id, id));
    expect(await failInterruptedBootstraps()).toBe(1);
    const after = await bootstrapRow(id);
    expect(after.status).toBe("failed");
    const personalize = after.steps.find((s) => s.key === "personalize")!;
    expect(personalize).toMatchObject({ status: "failed", message: M.interrupted });
    const failedItem = await actionRow(number);
    expect(failedItem.status).toBe("failed");
    expect(failedItem.errorMessage).toBe(`passo personalize: ${M.interrupted}`);
  });

  it("esecutore superato (richiesta chiusa da un altro processo): smette di scrivere, niente App", async () => {
    const { id, number } = await created();
    // Un altro container chiude la richiesta mentre questo sta ancora ispezionando il repository
    let closing: Promise<unknown> | null = null;
    gh.failWith = (req) => {
      if (!closing && req.path.startsWith(`/repos/${REPO}`)) {
        closing = db.update(appBootstrapsTable).set({ status: "failed" }).where(eq(appBootstrapsTable.id, id)).then(() => null);
      }
      return null;
    };
    const warn = vi.spyOn(logger, "warn");
    const approved = await approveAction(userId, number);
    expect(approved.ok).toBe(true);
    await settleBootstrapRuns();
    expect(closing).not.toBeNull();
    await closing;
    expect(warn.mock.calls.some((c) => String(c[1]).includes("non più in esecuzione"))).toBe(true);
    warn.mockRestore();
    const after = await bootstrapRow(id);
    expect(after.status).toBe("failed");
    expect(after.steps.every((s) => s.status === "pending")).toBe(true);
    expect(after.appId).toBeNull();
    expect(await db.select().from(appsTable)).toHaveLength(0);
    expect(commitCount()).toBe(1);
  });

  it("failInterruptedActions lascia stare le voci app_bootstrap in esecuzione", async () => {
    const { number } = await created();
    const item = await actionRow(number);
    await db.update(pendingActionsTable).set({ status: "executing" }).where(eq(pendingActionsTable.id, item.id));
    expect(await failInterruptedActions()).toBe(0);
    expect((await actionRow(number)).status).toBe("executing");
  });
});
