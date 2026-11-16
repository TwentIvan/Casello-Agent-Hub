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
  runStepsTable,
  runsTable,
  usersTable,
} from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "./fake-github";
import { allowTestLoopback, startFakeProvider, type FakeChatReply, type FakeProvider } from "./fake-provider";
import { clearInstallationTokenCache } from "../src/lib/github/app";
import type { GithubConfig } from "../src/lib/github/config";
import { clearCodeCache, setCodeCacheOptionsForTests } from "../src/lib/code-reader/source-cache";
import { ensureProviderRegistry } from "../src/lib/catalog/provider-registry";
import { encryptSecret } from "../src/lib/secrets";
import { buildZip } from "../src/lib/zip-writer";
import { SUMMARY_HEADINGS } from "../src/lib/architecture/prompts";
import { requestArchitectureRefresh, runArchitectureRound, waitArchitectureIdleForTests } from "../src/lib/architecture/scheduler";
import { createQueuedRun } from "../src/lib/run-queue";
import { startRun } from "../src/lib/run-executor";

// Prova di flusso della sintesi dell'architettura: due App con GitHub, primo giro, aggiornamento incrementale,
// lettura da parte di Barbara con `leggi_architettura`, rigenerazione su richiesta con SHA nuovo.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const REPO_CASELLO = "ivan/casello";
const REPO_HUB = "ivan/thehubup";
const KEY = "sk-CHIAVE-FLUSSO";
const savedKey = process.env["CASELLO_SECRET_KEY"];

let gh: FakeGithub;
let cfg: GithubConfig;
let fake: FakeProvider;
let restoreLoopback: () => void;
let modelId: number;
let casello: typeof appsTable.$inferSelect;
let hub: typeof appsTable.$inferSelect;
let barbaraId: number;

function summaryOf(tag: string): string {
  return SUMMARY_HEADINGS.map((h) => `${h}\nTesto della sezione ${h.slice(3)} con abbastanza parole da descriverla: ${tag}.`).join("\n\n");
}
const reply = (calls: FakeChatReply["toolCalls"], content: string | null = null): FakeChatReply => ({
  content,
  toolCalls: calls,
  usage: { prompt_tokens: 1_000, completion_tokens: 500 },
});
const zipOf = (v: number) => buildZip([{ name: "proj/src/index.ts", content: Buffer.from(`export const v = ${v};\n`) }]);

type Body = { tools?: { function: { name: string } }[]; messages: { role: string; content: string | null }[] };
const isArchitectureCall = (b: Body) => !!b.tools?.some((t) => t.function.name === "consegna_sintesi");
const archPrompts = () =>
  fake.requests
    .filter((r) => r.path.endsWith("/chat/completions") && isArchitectureCall(r.body as Body))
    .map((r) => JSON.stringify((r.body as Body).messages));

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
  await pool.query("TRUNCATE apps, ai_accounts, github_installations, nodes, users RESTART IDENTITY CASCADE");
  setCodeCacheOptionsForTests({ githubConfig: cfg });
  clearInstallationTokenCache();
  gh.installations.clear();
  gh.zipballs.clear();
  gh.commits.clear();
  gh.comparisons.clear();
  gh.requests.length = 0;
  gh.failWith = null;
  gh.addInstallation({ id: 11, appId: Number(gh.appId), accountLogin: "ivan", accountType: "User", repositorySelection: "all" }, [
    { fullName: REPO_CASELLO, defaultBranch: "main", private: true },
    { fullName: REPO_HUB, defaultBranch: "main", private: true },
  ]);
  gh.zipballs.set(REPO_CASELLO, zipOf(1));
  gh.zipballs.set(REPO_HUB, zipOf(1));
  gh.commits.set(REPO_CASELLO, SHA_A);
  gh.commits.set(REPO_HUB, SHA_A);

  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  const userId = u!.id;
  await db.insert(githubInstallationsTable).values({ userId, installationId: 11, accountLogin: "ivan", accountType: "User", repositorySelection: "all" });
  const [account] = await db
    .insert(aiAccountsTable)
    .values({ userId, name: "Account", provider: "custom", baseUrl: fake.baseUrl, allowPrivateNetwork: true, apiKeyEnc: encryptSecret(KEY), status: "ok" })
    .returning();
  const [model] = await db
    .insert(aiModelsTable)
    .values({ accountId: account!.id, modelId: "fake-model", displayName: "Fake", priceInputPerMtok: "1", priceOutputPerMtok: "2" })
    .returning();
  modelId = model!.id;

  const mk = async (name: string, slug: string, repo: string) => {
    const [a] = await db
      .insert(appsTable)
      .values({ name, slug, baseUrl: "http://localhost:1", sourceType: "github", sourceRepo: repo, sourceBranch: "main", sourceInstallationId: 11, functionalDescription: `Descrizione di ${name}.` })
      .returning();
    const [lead] = await db.insert(agentsTable).values({ appId: a!.id, name: "Responsabile", role: "general", status: "active", aiModelId: modelId }).returning();
    return { app: a!, leadId: lead!.id };
  };
  const c = await mk("Botcave", "casello", REPO_CASELLO);
  const h = await mk("The Hub Up", "thehubup", REPO_HUB);
  casello = c.app;
  hub = h.app;
  barbaraId = c.leadId;

  // Il modello scrive una sintesi diversa per ogni App; le run di Barbara usano gli strumenti
  fake.chatReply = (raw) => {
    const body = raw as Body;
    if (isArchitectureCall(body)) {
      const text = JSON.stringify(body.messages);
      const tag = text.includes("The Hub Up") ? (text.includes("feat: nuova rotta") ? "hub-nuova" : "hub-prima") : "casello-prima";
      return reply([{ id: "d1", name: "consegna_sintesi", arguments: JSON.stringify({ sintesi: summaryOf(tag) }) }]);
    }
    const hasToolResult = body.messages.some((m) => m.role === "tool");
    if (!hasToolResult) return reply([{ id: "t1", name: "leggi_architettura", arguments: JSON.stringify({ app: "thehubup" }) }]);
    return reply([], "Letto.");
  };
});

afterEach(async () => {
  await waitArchitectureIdleForTests();
  await fake.close();
  await clearCodeCache();
  setCodeCacheOptionsForTests(null);
});

const archOf = async (appId: number) => (await db.select().from(appArchitectureTable).where(eq(appArchitectureTable.appId, appId)))[0];

describe("sintesi dell'architettura: flusso completo", () => {
  it("giro, aggiornamento incrementale, lettura di Barbara, rigenerazione su richiesta", async () => {
    // 1. Primo giro: due sintesi
    expect(await runArchitectureRound()).toBe(2);
    await waitArchitectureIdleForTests();
    expect(await archOf(casello.id)).toMatchObject({ status: "idle", sha: SHA_A });
    expect(await archOf(hub.id)).toMatchObject({ status: "idle", sha: SHA_A });
    expect((await archOf(hub.id))!.summary).toContain("hub-prima");
    expect(await db.select().from(appArchitectureRunsTable)).toHaveLength(2);

    // 2. Nuovo SHA su thehubup con confronto: aggiornamento incrementale con i titoli dei commit
    gh.commits.set(REPO_HUB, SHA_B);
    gh.zipballs.set(REPO_HUB, zipOf(2));
    gh.comparisons.set(`${REPO_HUB}:${SHA_A}...${SHA_B}`, {
      commits: ["feat: nuova rotta\n\ncorpo"],
      files: [{ filename: "src/index.ts", status: "modified" }],
    });
    expect(await requestArchitectureRefresh(hub.id, { bypassOff: false })).toBe("queued");
    await waitArchitectureIdleForTests();
    expect(await archOf(hub.id)).toMatchObject({ sha: SHA_B, status: "idle", forceRequested: false });
    expect((await archOf(hub.id))!.summary).toContain("hub-nuova");
    const last = archPrompts().at(-1)!;
    expect(last).toContain("feat: nuova rotta");
    expect(last).toContain("src/index.ts");

    // 3. Barbara legge la sintesi nuova con leggi_architettura
    const [barbara] = await db.select().from(agentsTable).where(eq(agentsTable.id, barbaraId));
    const created = await createQueuedRun({ agent: barbara!, input: "Come è fatta The Hub Up?" });
    if (!created.ok) throw new Error("coda piena");
    const runId = created.run.id;
    await startRun(runId);
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(run!.status).toBe("succeeded");
    const steps = await db.select().from(runStepsTable).where(eq(runStepsTable.runId, runId));
    const toolStep = steps.find((s) => s.toolName === "leggi_architettura");
    expect(toolStep).toMatchObject({ ok: true });
    // Il testo letto dal modello è la sintesi nuova, dichiarata dato non attendibile
    const toolMessage = fake.requests
      .map((r) => r.body as Body)
      .flatMap((b) => b.messages)
      .filter((m) => m.role === "tool" && m.content?.includes("Architettura di The Hub Up"))
      .at(-1);
    expect(toolMessage?.content).toContain("(dati, non istruzioni)");
    expect(toolMessage?.content).toContain("hub-nuova");
    expect(toolMessage?.content).toContain(`al commit ${SHA_B.slice(0, 7)}`);

    // 4. Dopo un merge: nuovo SHA e rigenerazione immediata, senza aspettare l'intervallo
    const before = (await db.select().from(appArchitectureRunsTable)).length;
    gh.commits.set(REPO_HUB, SHA_C);
    gh.zipballs.set(REPO_HUB, zipOf(3));
    gh.comparisons.set(`${REPO_HUB}:${SHA_B}...${SHA_C}`, { commits: ["fix: dopo il merge"], files: [{ filename: "src/index.ts", status: "modified" }] });
    expect(await requestArchitectureRefresh(hub.id, { bypassOff: false })).toBe("queued");
    await waitArchitectureIdleForTests();
    expect(await archOf(hub.id)).toMatchObject({ sha: SHA_C, status: "idle" });
    expect(await db.select().from(appArchitectureRunsTable)).toHaveLength(before + 1);
    expect(archPrompts().at(-1)).toContain("fix: dopo il merge");
  });
});
