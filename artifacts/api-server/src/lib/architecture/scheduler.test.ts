import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  agentsTable,
  aiAccountsTable,
  aiModelsTable,
  appArchitectureRunsTable,
  appArchitectureTable,
  appsTable,
  githubInstallationsTable,
  nodesTable,
  usersTable,
  type App,
  type AppArchitecture,
} from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "../../../test/fake-provider";
import { clearInstallationTokenCache } from "../github/app";
import type { GithubConfig } from "../github/config";
import { clearCodeCache, setCodeCacheOptionsForTests } from "../code-reader/source-cache";
import { ensureProviderRegistry } from "../catalog/provider-registry";
import { encryptSecret } from "../secrets";
import { buildZip } from "../zip-writer";
import { ARCH_MESSAGES } from "./messages";
import { SUMMARY_HEADINGS } from "./prompts";
import {
  REFRESH_INTERVAL_MS,
  architectureEligibility,
  backoffMs,
  checkApp,
  claimGeneration,
  failInterruptedArchitecture,
  generateForApp,
  isDue,
  requestArchitectureRefresh,
  runArchitectureRound,
  waitArchitectureIdleForTests,
} from "./scheduler";

const H = 3_600_000;
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const REPO = "ivan/fanta";
const KEY = "sk-CHIAVE-ARCHITETTURA";

// --- funzioni pure ----------------------------------------------------------------------------------------------

function row(over: Partial<AppArchitecture> = {}): AppArchitecture {
  return {
    appId: 1,
    sha: SHA,
    branch: "main",
    seenSha: SHA2,
    repoMap: null,
    summary: "s",
    status: "idle",
    lastError: null,
    consecutiveErrors: 0,
    nextAttemptAt: null,
    checkedAt: null,
    generatedAt: new Date(0),
    startedAt: null,
    forceRequested: false,
    aiModelId: null,
    promptTokens: null,
    completionTokens: null,
    costUsd: null,
    ...over,
  };
}

describe("isDue e backoffMs", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("intervalli", () => {
    expect(REFRESH_INTERVAL_MS).toEqual({ hourly: H, "6h": 6 * H, daily: 24 * H, weekly: 7 * 24 * H });
    expect(isDue(row({ generatedAt: ago(5 * H) }), "6h", now)).toBe(false);
    expect(isDue(row({ generatedAt: ago(6 * H) }), "6h", now)).toBe(true);
    expect(isDue(row({ generatedAt: ago(59 * 60_000) }), "hourly", now)).toBe(false);
    expect(isDue(row({ generatedAt: ago(H) }), "hourly", now)).toBe(true);
    expect(isDue(row({ generatedAt: ago(23 * H) }), "daily", now)).toBe(false);
    expect(isDue(row({ generatedAt: ago(24 * H) }), "daily", now)).toBe(true);
    expect(isDue(row({ generatedAt: ago(6 * 24 * H) }), "weekly", now)).toBe(false);
    expect(isDue(row({ generatedAt: ago(7 * 24 * H) }), "weekly", now)).toBe(true);
  });

  it("SHA uguale o non letto: mai", () => {
    expect(isDue(row({ seenSha: SHA, generatedAt: ago(48 * H) }), "6h", now)).toBe(false);
    expect(isDue(row({ seenSha: null, generatedAt: ago(48 * H) }), "6h", now)).toBe(false);
  });

  it("prima sintesi (sha e generatedAt null): subito", () => {
    expect(isDue(row({ sha: null, generatedAt: null }), "weekly", now)).toBe(true);
  });

  it("forceRequested salta l'intervallo, anche con off", () => {
    expect(isDue(row({ generatedAt: ago(60_000), forceRequested: true }), "weekly", now)).toBe(true);
    expect(isDue(row({ generatedAt: ago(60_000), forceRequested: true }), "off", now)).toBe(true);
    expect(isDue(row({ generatedAt: ago(30 * 24 * H) }), "off", now)).toBe(false);
  });

  it("nextAttemptAt futuro blocca, passato no", () => {
    expect(isDue(row({ nextAttemptAt: new Date(now.getTime() + 1000) }), "6h", now)).toBe(false);
    expect(isDue(row({ nextAttemptAt: new Date(now.getTime() + 1000), forceRequested: true }), "6h", now)).toBe(false);
    expect(isDue(row({ nextAttemptAt: ago(1000) }), "6h", now)).toBe(true);
  });

  it("backoff: 30 min × 2^errori, al più 24 h", () => {
    expect(backoffMs(0)).toBe(30 * 60_000);
    expect(backoffMs(1)).toBe(60 * 60_000);
    expect(backoffMs(5)).toBe(16 * H);
    expect(backoffMs(6)).toBe(24 * H);
    expect(backoffMs(10)).toBe(24 * H);
  });
});

// --- con DB, finto GitHub e finto provider --------------------------------------------------------------------

let gh: FakeGithub;
let cfg: GithubConfig;
let fake: FakeProvider;
let restoreLoopback: () => void;
let userId: number;
let accountId: number;
let modelId: number;
let app: App;
let leadId: number;
const savedKey = process.env["CASELLO_SECRET_KEY"];

function validSummary(tag = ""): string {
  return SUMMARY_HEADINGS.map((h) => `${h}\nTesto della sezione ${h.slice(3)} con abbastanza parole da descriverla ${tag}.`).join("\n\n");
}
const deliver = (sintesi: string): FakeChatReply => ({
  content: null,
  toolCalls: [{ id: "d1", name: "consegna_sintesi", arguments: JSON.stringify({ sintesi }) }],
  usage: { prompt_tokens: 1_000, completion_tokens: 500 },
});
const chatCalls = () => fake.requests.filter((r) => r.path.endsWith("/chat/completions")).length;

async function archRow(): Promise<AppArchitecture | undefined> {
  const [r] = await db.select().from(appArchitectureTable).where(eq(appArchitectureTable.appId, app.id));
  return r;
}
const runs = () => db.select().from(appArchitectureRunsTable).where(eq(appArchitectureRunsTable.appId, app.id)).orderBy(appArchitectureRunsTable.id);

beforeAll(async () => {
  restoreLoopback = allowTestLoopback();
  process.env["CASELLO_SECRET_KEY"] = "a".repeat(64);
  vi.spyOn(console, "log").mockImplementation(() => {});
  gh = await startFakeGithub();
  cfg = {
    appId: gh.appId,
    slug: gh.slug,
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    privateKey: gh.privateKeyPem,
    apiBase: gh.apiBase,
    webBase: gh.webBase,
  };
  await ensureProviderRegistry();
});

afterAll(async () => {
  await gh.close();
  restoreLoopback();
  if (savedKey === undefined) delete process.env["CASELLO_SECRET_KEY"];
  else process.env["CASELLO_SECRET_KEY"] = savedKey;
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, nodes, users RESTART IDENTITY CASCADE");
  await pool.end();
});

beforeEach(async () => {
  fake = await startFakeProvider({ apiKey: KEY });
  fake.chatReply = () => deliver(validSummary());
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, nodes, users RESTART IDENTITY CASCADE");
  setCodeCacheOptionsForTests({ githubConfig: cfg });
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.zipballs.clear();
  gh.commits.clear();
  gh.comparisons.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.addInstallation(
    { id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" },
    [{ fullName: REPO, defaultBranch: "main", private: true }],
  );
  gh.zipballs.set(REPO, buildZip([{ name: "proj/src/index.ts", content: Buffer.from("export const v = 1;\n") }]));
  gh.commits.set(REPO, SHA);

  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = u!.id;
  await db.insert(githubInstallationsTable).values({ userId, installationId: 11, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  accountId = account!.id;
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;
  const [a] = await db
    .insert(appsTable)
    .values({
      name: "Fanta",
      slug: "fanta",
      baseUrl: "http://localhost:1",
      sourceType: "github",
      sourceRepo: REPO,
      sourceBranch: "main",
      sourceInstallationId: 11,
      functionalDescription: "Gestione delle leghe.",
    })
    .returning();
  app = a!;
  const [lead] = await db.insert(agentsTable).values({ appId: app.id, name: "Responsabile", role: "general", status: "active", aiModelId: modelId }).returning();
  leadId = lead!.id;
});

afterEach(async () => {
  await waitArchitectureIdleForTests();
  await fake.close();
  await clearCodeCache();
  setCodeCacheOptionsForTests(null);
});

describe("architectureEligibility", () => {
  it("idonea: Responsabile, pagatore e modello", async () => {
    const e = await architectureEligibility(app);
    expect(e).toMatchObject({ ok: true, payerUserId: userId, aiModelId: modelId });
    if (e.ok) expect(e.lead.id).toBe(leadId);
  });

  it("senza GitHub tramite installazione: noGithub", async () => {
    expect(await architectureEligibility({ ...app, sourceInstallationId: null })).toEqual({ ok: false, reason: ARCH_MESSAGES.noGithub });
  });

  it("Responsabile senza modello: noLead", async () => {
    await db.update(agentsTable).set({ aiModelId: null }).where(eq(agentsTable.id, leadId));
    expect(await architectureEligibility(app)).toEqual({ ok: false, reason: ARCH_MESSAGES.noLead });
  });

  it("modello nodo con ripiego cloud: usa il ripiego, pagatore il proprietario", async () => {
    const [node] = await db.insert(nodesTable).values({ userId, name: "mac" }).returning();
    const [nodeAcc] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Nodo", provider: "claude_code_node", baseUrl: "", apiKeyEnc: null, nodeId: node!.id, fallbackAiModelId: modelId })
      .returning();
    const [nodeModel] = await db.insert(aiModelsTable).values({ accountId: nodeAcc!.id, modelId: "sonnet", displayName: "sonnet" }).returning();
    await db.update(agentsTable).set({ aiModelId: nodeModel!.id }).where(eq(agentsTable.id, leadId));
    expect(await architectureEligibility(app)).toMatchObject({ ok: true, aiModelId: modelId, payerUserId: userId });
  });

  it("modello nodo senza ripiego: nodeNoFallback", async () => {
    const [node] = await db.insert(nodesTable).values({ userId, name: "mac" }).returning();
    const [nodeAcc] = await db
      .insert(aiAccountsTable)
      .values({ userId, name: "Nodo", provider: "claude_code_node", baseUrl: "", apiKeyEnc: null, nodeId: node!.id })
      .returning();
    const [nodeModel] = await db.insert(aiModelsTable).values({ accountId: nodeAcc!.id, modelId: "sonnet", displayName: "sonnet" }).returning();
    await db.update(agentsTable).set({ aiModelId: nodeModel!.id }).where(eq(agentsTable.id, leadId));
    expect(await architectureEligibility(app)).toEqual({ ok: false, reason: ARCH_MESSAGES.nodeNoFallback });
    await generateForApp(app.id);
    expect(await archRow()).toMatchObject({ status: "error", lastError: ARCH_MESSAGES.nodeNoFallback, consecutiveErrors: 1 });
    expect(chatCalls()).toBe(0);
  });
});

describe("checkApp e generateForApp", () => {
  it("primo giro: genera, riga idle con sha e una run con costo", async () => {
    await checkApp(app);
    const r = await archRow();
    expect(r).toMatchObject({ status: "idle", sha: SHA, seenSha: SHA, branch: "main", consecutiveErrors: 0, lastError: null, forceRequested: false, aiModelId: modelId });
    expect(r!.summary).toBe(validSummary());
    expect(r!.repoMap).toContain("index.ts");
    expect(r!.generatedAt).not.toBeNull();
    expect(r!.checkedAt).not.toBeNull();
    const rs = await runs();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ sha: SHA, agentId: leadId, aiModelId: modelId, userId, promptTokens: 1_000, completionTokens: 500 });
    expect(Number(rs[0]!.costUsd)).toBeCloseTo(0.002, 6);
    expect(rs[0]!.summary).toBe(validSummary());
  });

  it("stesso SHA: nessuna generazione; SHA nuovo entro l'intervallo: nessuna", async () => {
    await checkApp(app);
    expect(chatCalls()).toBe(1);
    await checkApp(app);
    expect(chatCalls()).toBe(1);
    gh.commits.set(REPO, SHA2);
    await checkApp(app);
    expect(chatCalls()).toBe(1);
    expect(await archRow()).toMatchObject({ sha: SHA, seenSha: SHA2 });
    expect(await runs()).toHaveLength(1);
  });

  it("requestArchitectureRefresh: genera subito lo SHA nuovo", async () => {
    await checkApp(app);
    gh.commits.set(REPO, SHA2);
    gh.zipballs.set(REPO, buildZip([{ name: "proj/src/index.ts", content: Buffer.from("export const v = 2;\n") }]));
    fake.chatReply = () => deliver(validSummary("nuova"));
    expect(await requestArchitectureRefresh(app.id, { bypassOff: false })).toBe("queued");
    await waitArchitectureIdleForTests();
    expect(await archRow()).toMatchObject({ sha: SHA2, forceRequested: false, status: "idle", summary: validSummary("nuova") });
    expect(await runs()).toHaveLength(2);
  });

  it("requestArchitectureRefresh con off: nulla senza bypassOff, generazione con bypassOff", async () => {
    await db.update(appsTable).set({ architectureRefresh: "off" }).where(eq(appsTable.id, app.id));
    expect(await requestArchitectureRefresh(app.id, { bypassOff: false })).toBe("off");
    await waitArchitectureIdleForTests();
    expect(chatCalls()).toBe(0);
    expect(await requestArchitectureRefresh(app.id, { bypassOff: true })).toBe("queued");
    await waitArchitectureIdleForTests();
    expect(await archRow()).toMatchObject({ sha: SHA, status: "idle" });
  });

  it("requestArchitectureRefresh: app inesistente e generazione in corso", async () => {
    expect(await requestArchitectureRefresh(99_999, { bypassOff: true })).toBe(ARCH_MESSAGES.appNotFound);
    expect(await claimGeneration(app.id)).toBe(true);
    expect(await requestArchitectureRefresh(app.id, { bypassOff: true })).toBe("running");
  });

  it("due claimGeneration concorrenti: una sola vera (Review Focus)", async () => {
    const out = await Promise.all([claimGeneration(app.id), claimGeneration(app.id), claimGeneration(app.id)]);
    expect(out.filter(Boolean)).toHaveLength(1);
    const r = await archRow();
    expect(r).toMatchObject({ status: "running" });
    expect(r!.startedAt).not.toBeNull();
  });

  it("branch sparito (404): error con backoff, sintesi precedente intatta (Review Focus)", async () => {
    await checkApp(app);
    const before = await archRow();
    gh.commits.delete(REPO);
    const t0 = Date.now();
    await checkApp(app);
    const r = await archRow();
    expect(r).toMatchObject({ status: "error", consecutiveErrors: 1, summary: before!.summary, sha: SHA });
    expect(r!.lastError).toBeTruthy();
    expect(r!.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(t0 + 30 * 60_000 - 5_000);
    expect(r!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 5_000);
    // In attesa del backoff: niente rete, solo checked_at
    const reqs = gh.requests.length;
    await checkApp(app);
    expect(gh.requests.length).toBe(reqs);
    expect((await archRow())!.consecutiveErrors).toBe(1);
  });

  it("tetto dell'agente raggiunto: nessuna chiamata al modello, budgetWait, nessun errore contato", async () => {
    await db.update(agentsTable).set({ monthlyBudgetUsd: "0" }).where(eq(agentsTable.id, leadId));
    await checkApp(app);
    expect(chatCalls()).toBe(0);
    expect(await archRow()).toMatchObject({ status: "idle", lastError: ARCH_MESSAGES.budgetWait, consecutiveErrors: 0, nextAttemptAt: null, sha: null });
    expect(await runs()).toHaveLength(0);
  });

  it("pagatore senza installazione: noAccess", async () => {
    await pool.query("TRUNCATE github_installations RESTART IDENTITY CASCADE");
    await generateForApp(app.id);
    expect(await archRow()).toMatchObject({ status: "error", lastError: ARCH_MESSAGES.noAccess, consecutiveErrors: 1 });
    expect(chatCalls()).toBe(0);
  });

  it("generazione fallita dopo il modello: run con summary null, errore con backoff", async () => {
    fake.chatReply = () => ({ content: "a parole", toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    await generateForApp(app.id);
    expect(await archRow()).toMatchObject({ status: "error", lastError: ARCH_MESSAGES.notDelivered, consecutiveErrors: 1, sha: null, summary: null });
    const rs = await runs();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ summary: null, promptTokens: 100, userId, aiModelId: modelId });
  });

  it("failInterruptedArchitecture chiude le running", async () => {
    expect(await claimGeneration(app.id)).toBe(true);
    await failInterruptedArchitecture();
    expect(await archRow()).toMatchObject({ status: "error", lastError: ARCH_MESSAGES.interrupted });
  });

  it("oltre 20 versioni: la più vecchia ha summary null", async () => {
    for (let i = 0; i < 20; i++) {
      await db.insert(appArchitectureRunsTable).values({ appId: app.id, agentId: leadId, sha: SHA2, summary: `v${i}`, createdAt: new Date(Date.now() - (30 - i) * 60_000) });
    }
    await generateForApp(app.id);
    const rs = await runs();
    expect(rs).toHaveLength(21);
    expect(rs[0]!.summary).toBeNull();
    expect(rs.filter((r) => r.summary !== null)).toHaveLength(20);
    expect(rs[20]!.summary).toBe(validSummary());
  });
});

describe("runArchitectureRound", () => {
  it("genera le app idonee", async () => {
    expect(await runArchitectureRound()).toBe(1);
    expect(await archRow()).toMatchObject({ status: "idle", sha: SHA });
  });

  it("Responsabile disattivato: app esclusa dal giro, sintesi intatta (Review Focus)", async () => {
    await checkApp(app);
    const before = await archRow();
    gh.commits.set(REPO, SHA2);
    await db.update(agentsTable).set({ status: "inactive" }).where(eq(agentsTable.id, leadId));
    await db.update(appArchitectureTable).set({ forceRequested: true }).where(eq(appArchitectureTable.appId, app.id));
    gh.requests.length = 0;
    expect(await runArchitectureRound()).toBe(0);
    expect(gh.requests).toHaveLength(0);
    const r = await archRow();
    expect(r).toMatchObject({ summary: before!.summary, sha: SHA, status: "idle" });
  });

  it("frequenza off: app esclusa", async () => {
    await db.update(appsTable).set({ architectureRefresh: "off" }).where(eq(appsTable.id, app.id));
    expect(await runArchitectureRound()).toBe(0);
    expect(await archRow()).toBeUndefined();
  });
});
