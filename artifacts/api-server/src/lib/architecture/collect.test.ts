import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, pool, appsTable, githubInstallationsTable, usersTable, type App } from "@workspace/db";
import { startFakeGithub, type FakeGithub } from "../../../test/fake-github";
import { clearInstallationTokenCache } from "../github/app";
import type { GithubConfig } from "../github/config";
import { clearCodeCache, setCodeCacheOptionsForTests } from "../code-reader/source-cache";
import { buildZip } from "../zip-writer";
import { ArchitectureError, collectMaterials } from "./collect";
import { ARCH_MESSAGES } from "./messages";

const SHA = "a".repeat(40);
const PREV = "c".repeat(40);
const REPO = "ivan/fanta";

let gh: FakeGithub;
let cfg: GithubConfig;
let userId: number;

beforeAll(async () => {
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
  const [u] = await db.insert(usersTable).values({ email: "ivan@example.com", name: "Ivan" }).returning();
  userId = u!.id;
  await db.insert(githubInstallationsTable).values({
    userId,
    installationId: 11,
    accountLogin: "ivan",
    accountType: "User",
    repositorySelection: "all",
  });
});

afterAll(async () => {
  await gh.close();
  await pool.query("TRUNCATE apps, github_installations, users RESTART IDENTITY CASCADE");
  await pool.end();
});

beforeEach(() => {
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
});

afterEach(async () => {
  await clearCodeCache();
  setCodeCacheOptionsForTests(null);
  await pool.query("TRUNCATE apps RESTART IDENTITY CASCADE");
});

async function mkApp(over: Partial<typeof appsTable.$inferInsert> = {}): Promise<App> {
  const [row] = await db
    .insert(appsTable)
    .values({
      name: "Fanta",
      slug: `app-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "http://localhost:1",
      sourceType: "github",
      sourceRepo: REPO,
      sourceBranch: "main",
      sourceInstallationId: 11,
      functionalDescription: "Gestione delle leghe di fantacalcio.",
      ...over,
    })
    .returning();
  return row!;
}

const compareReqs = () => gh.requests.filter((r) => r.path.includes("/compare/"));

describe("collectMaterials", () => {
  it("prima volta: full, nessun confronto, mappa e descrizione", async () => {
    const app = await mkApp();
    const m = await collectMaterials({ userId, app, previousSha: null, previousSummary: null });
    expect(m).toMatchObject({ sha: SHA, branch: "main", full: true, commits: [], files: [], truncated: false, previousSummary: null });
    expect(m.functional).toBe("Gestione delle leghe di fantacalcio.");
    expect(m.repoMap).toContain("index.ts (1 righe");
    expect(m.source.sha).toBe(SHA);
    expect(compareReqs()).toHaveLength(0);
  });

  it("SHA precedente noto: commit e file dal confronto", async () => {
    gh.comparisons.set(`${REPO}:${PREV}...${SHA}`, {
      commits: ["feat: uno\n\ncorpo", "fix: due"],
      files: [
        { filename: "src/a.ts", status: "added" },
        { filename: "src/b.ts", status: "modified" },
      ],
    });
    const app = await mkApp();
    const m = await collectMaterials({ userId, app, previousSha: PREV, previousSummary: "## Scopo\nvecchia" });
    expect(m.full).toBe(false);
    expect(m.commits).toEqual(["feat: uno", "fix: due"]);
    expect(m.files).toEqual([
      { filename: "src/a.ts", status: "added" },
      { filename: "src/b.ts", status: "modified" },
    ]);
    expect(m.previousSummary).toBe("## Scopo\nvecchia");
    expect(compareReqs()).toHaveLength(1);
  });

  it("SHA precedente sconosciuto (storia riscritta): full", async () => {
    const app = await mkApp();
    const m = await collectMaterials({ userId, app, previousSha: PREV, previousSummary: "## Scopo\nvecchia" });
    expect(m.full).toBe(true);
    expect(m.commits).toEqual([]);
    expect(m.files).toEqual([]);
    expect(compareReqs()).toHaveLength(1);
  });

  it("branch non indicato: usa il predefinito del repository", async () => {
    const app = await mkApp({ sourceBranch: null });
    const m = await collectMaterials({ userId, app, previousSha: null, previousSummary: null });
    expect(m.branch).toBe("main");
  });

  it("descrizione funzionale troncata a 12 000 caratteri", async () => {
    const app = await mkApp({ functionalDescription: "x".repeat(13_000) });
    const m = await collectMaterials({ userId, app, previousSha: null, previousSummary: null });
    expect(m.functional).toHaveLength(12_000);
  });

  it("GitHub non raggiungibile: errore fisso", async () => {
    gh.failWith = (req) => (req.path.includes("/zipball") || req.path.includes("/commits/") ? 503 : null);
    const app = await mkApp();
    const err = await collectMaterials({ userId, app, previousSha: null, previousSummary: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchitectureError);
    expect((err as Error).message).toBe(ARCH_MESSAGES.githubDown);
  });

  it("app senza installazione: errore fisso", async () => {
    const app = await mkApp({ sourceInstallationId: null });
    const err = await collectMaterials({ userId, app, previousSha: null, previousSummary: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchitectureError);
    expect((err as Error).message).toBe(ARCH_MESSAGES.noGithub);
  });
});
